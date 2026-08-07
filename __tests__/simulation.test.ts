/**
 * 工程控制论改造 — 端到端集成验证（模拟 60 天真实使用）
 *
 * 验证三件事：
 * 1. 集成：mock pi API 走真实的 memory_recall 工具，命中打点确实生效（闭环信号进入系统）
 * 2. 闭环：同一 store 内「定期被检索命中」的记忆 vs「从不命中」的记忆，potency 分化——
 *    命中的留存、未命中的沉底归档，且归档后不再被注入
 * 3. 自寻最优：高命中率场景衰减系数自动放宽、低命中率场景自动收紧（无写死参数）
 *
 * 运行: node __tests__/simulation.test.ts
 */

import { MemoryStore } from "../src/store.ts";
import { MemoryInjector } from "../src/injector.ts";
import { registerTools } from "../src/tools.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

const DAY = 86_400_000;
const tmpPath = (): string => `/tmp/pi-memory-sim-${Date.now()}-${Math.random()}.json`;

/** 模拟一个 session：衰减 + 自适应评估 + 注入（与 index.ts session_start 一致） */
function simulateSession(store: MemoryStore, injector: MemoryInjector, simNow: number): string[] {
  store.mutate(() => {
    store.applyDecay(simNow);
    store.adapt(simNow);
  });
  const snapshot = injector.build([], undefined, 2000);
  return snapshot.injectedIds;
}

// ─── 1. 集成验证：真实 memory_recall 工具链路 ───
async function testToolIntegration() {
  console.log("\n📋 集成验证: memory_recall 工具命中打点（mock pi API 全链路）");

  const store = new MemoryStore({ storePath: tmpPath(), config: { decayFactor: 0.95 } });
  const m = store.add({ type: "decision", content: "项目使用 JWT 认证", paths: [], potency: 0.5, source: "manual", tags: ["auth"] });
  store.save();

  // mock 最小 pi API，注册真实工具
  const registered: Record<string, any> = {};
  const pi = {
    registerTool: (tool: any) => { registered[tool.name] = tool; },
  } as any;
  registerTools(pi, store);

  // agent 调用 memory_recall 检索「认证」
  const result = await registered.memory_recall.execute("t1", { query: "JWT" }, null, null);
  assert(result.content[0].text.includes("JWT"), "工具返回命中记忆");

  const after = store.getById(m.id)!;
  assert(Math.abs(after.potency - 0.53) < 1e-9, "命中后 potency +0.03（0.5 → 0.53）");
  assert(after.recallHitCount === 1, "recallHitCount = 1");
  const stats = (store as any).data.adaptation;
  assert(stats.recallHits === 1, "自寻最优统计窗口 recallHits = 1");

  // 未命中查询不打点
  await registered.memory_recall.execute("t2", { query: "不存在的关键词xyz" }, null, null);
  assert((store as any).data.adaptation.recallHits === 1, "未命中查询不产生强化/统计");
  assert(store.getById(m.id)!.potency === 0.53, "未命中后 potency 不变");
}

// ─── 2+3. 60 天模拟：闭环分化 + 自寻最优 ───
function simulate60Days() {
  console.log("\n📋 模拟验证: 60 天双场景（每 2 天一个 session，与真实使用节律一致）");

  // ── 场景 High：10 条记忆，每 session 命中其中 4 条常用记忆 ──
  const highStore = new MemoryStore({ storePath: tmpPath(), config: { decayFactor: 0.95 } });
  const highInjector = new MemoryInjector(highStore);
  const common: string[] = [];
  for (let i = 0; i < 4; i++) {
    common.push(highStore.add({ type: "convention", content: `常用约定 ${i}：接口文档必须同步更新`, paths: [], potency: 0.8, source: "auto", tags: [] }).id);
  }
  const rare: string[] = [];
  for (let i = 0; i < 6; i++) {
    rare.push(highStore.add({ type: "fact", content: `冷门事实 ${i}：某次构建环境变量细节`, paths: [], potency: 0.8, source: "auto", tags: [] }).id);
  }
  highStore.save();

  // ── 场景 Low：10 条记忆，从不被检索命中 ──
  const lowStore = new MemoryStore({ storePath: tmpPath(), config: { decayFactor: 0.95 } });
  const lowInjector = new MemoryInjector(lowStore);
  for (let i = 0; i < 10; i++) {
    lowStore.add({ type: "fact", content: `低频事实 ${i}：边缘配置说明`, paths: [], potency: 0.8, source: "auto", tags: [] });
  }
  lowStore.save();

  const now0 = Date.now();
  const trace: Array<{ day: number; highCommon: number; highRare: number; highFactor: number; lowFactor: number }> = [];

  for (let day = 0; day <= 60; day += 2) {
    const simNow = now0 + day * DAY;
    const highInjected = simulateSession(highStore, highInjector, simNow);
    const lowInjected = simulateSession(lowStore, lowInjector, simNow);

    // 高场景：每 session 命中 4 条常用记忆（模拟 agent 反复检索它们）
    // 与生产 tools.ts 一致：命中打点必须包 mutate；now 用模拟时间（与 applyDecay/adapt 同一时间轴）
    highStore.mutate(() => highStore.registerRecallHits(common, simNow));

    if (day % 10 === 0) {
      const hc = highStore.getById(common[0])!.potency;
      const hr = highStore.getById(rare[0])!.potency;
      trace.push({
        day,
        highCommon: hc,
        highRare: hr,
        highFactor: highStore.getActiveDecayFactor(),
        lowFactor: lowStore.getActiveDecayFactor(),
      });
    }
    // 防止低场景 store 被误命中（无命中调用）
    void lowInjected;
  }

  // ── 结果断言 ──
  console.log("\n  60 天 potency 演化轨迹（常用 vs 冷门 vs 衰减系数）:");
  console.log("  第几天 | 常用记忆 | 冷门记忆 | 高场景衰减系数 | 低场景衰减系数");
  for (const t of trace) {
    console.log(`  ${String(t.day).padStart(4)}天 |   ${t.highCommon.toFixed(3)}  |  ${t.highRare.toFixed(3)}  |    ${t.highFactor.toFixed(3)}       |    ${t.lowFactor.toFixed(3)}`);
  }

  // 闭环：常用记忆存活、冷门记忆沉底
  const finalCommon = highStore.getById(common[0])!.potency;
  const finalRare = highStore.getById(rare[0])!.potency;
  assert(finalCommon >= 0.3, `常用记忆 60 天后 potency=${finalCommon.toFixed(3)} ≥ 0.3（活跃，靠命中维持）`);
  assert(finalRare < 0.2, `冷门记忆 60 天后 potency=${finalRare.toFixed(3)} < 0.2（归档，从不命中自然沉底）`);
  assert(finalCommon > finalRare + 0.2, `闭环分化明显：常用(${finalCommon.toFixed(2)}) 比冷门(${finalRare.toFixed(2)}) 高 0.2+`);

  // 归档隔离：冷门记忆不再被注入，常用记忆继续被注入
  highInjector.build([], undefined, 2000);
  const lastSnapshot = highInjector.getCurrentSnapshot();
  const rareInjected = lastSnapshot!.injectedIds.filter((id) => rare.includes(id));
  const commonInjected = lastSnapshot!.injectedIds.filter((id) => common.includes(id));
  assert(rareInjected.length === 0, `归档的冷门记忆不再注入（冷门 0 条）`);
  assert(commonInjected.length > 0, `常用记忆 60 天后仍被注入（${commonInjected.length} 条）`);

  // 自寻最优：高命中放宽、低命中收紧
  const highFactor = highStore.getActiveDecayFactor();
  const lowFactor = lowStore.getActiveDecayFactor();
  assert(highFactor > 0.95, `高命中率场景衰减系数放宽: 0.95 → ${highFactor.toFixed(2)}（记忆有用，留得更久）`);
  assert(lowFactor < 0.95, `低命中率场景衰减系数收紧: 0.95 → ${lowFactor.toFixed(2)}（注入没用，忘得更快）`);
}

// ─── 运行 ───
console.log("🧪 工程控制论改造 — 端到端模拟验证");
console.log("=".repeat(52));

await testToolIntegration();
simulate60Days();

console.log("\n" + "=".repeat(52));
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
