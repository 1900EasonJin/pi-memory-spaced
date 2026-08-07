/**
 * 工程控制论改造测试 — 闭环反馈（检索命中强化）+ 自寻最优（命中率自适应衰减）
 *
 * 纯 Node.js 测试，不依赖任何测试框架。
 * 运行: node __tests__/cybernetics.test.ts
 */

import { MemoryStore } from "../src/store.ts";

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

function createTestStore(): MemoryStore {
  return new MemoryStore({
    storePath: `/tmp/pi-memory-cyber-${Date.now()}-${Math.random()}.json`,
    config: { decayFactor: 0.95 },
  });
}

const DAY = 86_400_000;

// ─── 1. 闭环反馈：检索命中 = 复习成功 ───
function testRecallFeedback() {
  console.log("\n📋 测试: 闭环反馈（memory_recall 命中强化）");

  const store = createTestStore();
  const m = store.add({ type: "decision", content: "使用 JWT 认证", paths: [], potency: 0.5, source: "manual", tags: [] });

  store.save(); // mutate 会先 reload 磁盘，落盘后再走生产调用链
  store.mutate(() => store.registerRecallHits([m.id]));
  const after = store.getById(m.id)!;
  assert(Math.abs(after.potency - 0.53) < 1e-9, "命中后 potency +recallBoost(0.03)");
  assert(after.recallHitCount === 1, "recallHitCount 累计为 1");

  // 重置衰减锚点：命中后立即衰减不再掉 potency（复习成功重置计时）
  store.update(after.id, { lastDecayedAt: Date.now() - 10 * DAY });
  store.save();
  store.mutate(() => store.registerRecallHits([m.id]));
  store.applyDecay();
  const reHit = store.getById(m.id)!;
  // 容差比较：命中与 applyDecay 之间若隔几毫秒，微小衰减会使严格相等断言偶发失败（测试竞态）
  assert(Math.abs(reHit.potency - 0.56) < 1e-9, "命中重置锚点后，同一时刻衰减不生效（0.56 = 0.53 + 0.03）");

  // 多次命中封顶 1.0
  store.save();
  store.mutate(() => store.registerRecallHits(Array(20).fill(m.id)));
  assert(store.getById(m.id)!.potency === 1, "potency 封顶 1.0");

  // 固化记忆不再强化，但仍计数（自寻最优统计）
  const t = store.add({ type: "fact", content: "固化记忆", paths: [], potency: 0.9, source: "manual", tags: [] });
  store.update(t.id, { tenured: true });
  store.save();
  store.mutate(() => store.registerRecallHits([t.id]));
  assert(store.getById(t.id)!.potency === 0.9, "固化记忆命中不强化");
  assert(store.getById(t.id)!.recallHitCount === undefined, "固化记忆不计 recallHitCount");

  // 空 id 列表无副作用
  store.save();
  store.mutate(() => store.registerRecallHits([]));
  assert(store.getById(m.id)!.potency === 1, "空列表不改变 potency");
}

// ─── 2. 自寻最优：窗口期满 + 样本充足才调节 ───
function testAdaptation() {
  console.log("\n📋 测试: 自寻最优（命中率自适应衰减系数）");

  // 窗口未满 → 不调节
  const store = createTestStore();
  const m = store.add({ type: "fact", content: "样本", paths: [], potency: 0.8, source: "manual", tags: [] });
  for (let i = 0; i < 40; i++) store.registerInjection(m.id);
  store.mutate(() => store.registerRecallHits([m.id]));
  assert(store.adapt() === undefined, "窗口未满（<7 天）不调节");
  assert(store.getActiveDecayFactor() === 0.95, "窗口未满时衰减系数不变");

  // 窗口满但样本不足（<30）→ 重置窗口，不调节
  const store2 = createTestStore();
  const m2 = store2.add({ type: "fact", content: "样本2", paths: [], potency: 0.8, source: "manual", tags: [] });
  for (let i = 0; i < 10; i++) store2.registerInjection(m2.id);
  const later = Date.now() + 8 * DAY;
  assert(store2.adapt(later) === undefined, "窗口满但样本不足不调节");
  const s2 = (store2 as any).data.adaptation;
  assert(s2.windowStart === later && s2.injections === 0, "样本不足时滚动到新窗口");

  // 高命中率（20/40 = 0.5 ≥ 0.3）→ 放宽衰减
  const store3 = createTestStore();
  const m3 = store3.add({ type: "fact", content: "样本3", paths: [], potency: 0.8, source: "manual", tags: [] });
  for (let i = 0; i < 40; i++) store3.registerInjection(m3.id);
  store3.registerRecallHits(Array(20).fill(m3.id));
  const adjusted = store3.adapt(Date.now() + 8 * DAY);
  assert(adjusted === 0.96, "命中率 0.5 → 衰减系数放宽为 0.96");

  // 低命中率（0/40 = 0 < 0.05）→ 收紧衰减
  const store4 = createTestStore();
  const m4 = store4.add({ type: "fact", content: "样本4", paths: [], potency: 0.8, source: "manual", tags: [] });
  for (let i = 0; i < 40; i++) store4.registerInjection(m4.id);
  const tightened = store4.adapt(Date.now() + 8 * DAY);
  assert(tightened === 0.94, "命中率 0 → 衰减系数收紧为 0.94");

  // 中间命中率（4/40 = 0.1）→ 不动
  const store5 = createTestStore();
  const m5 = store5.add({ type: "fact", content: "样本5", paths: [], potency: 0.8, source: "manual", tags: [] });
  for (let i = 0; i < 40; i++) store5.registerInjection(m5.id);
  store5.registerRecallHits(Array(4).fill(m5.id));
  assert(store5.adapt(Date.now() + 8 * DAY) === 0.95, "命中率 0.1 在死区内，系数不变");

  // 边界：上限 0.97 / 下限 0.90（每轮 adapt 后窗口重置，需重新补样本）
  const seedRound = (store: MemoryStore, id: string, hits: number): void => {
    for (let i = 0; i < 40; i++) store.registerInjection(id);
    store.registerRecallHits(Array(hits).fill(id));
  };
  const store6 = createTestStore();
  const m6 = store6.add({ type: "fact", content: "样本6", paths: [], potency: 0.8, source: "manual", tags: [] });
  seedRound(store6, m6.id, 40);
  store6.adapt(Date.now() + 8 * DAY); // 0.96
  seedRound(store6, m6.id, 40);
  store6.adapt(Date.now() + 16 * DAY); // 0.97
  seedRound(store6, m6.id, 40);
  store6.adapt(Date.now() + 24 * DAY); // 上限封顶
  assert(store6.getActiveDecayFactor() === 0.97, "放宽上限封顶 0.97");

  const store7 = createTestStore();
  const m7 = store7.add({ type: "fact", content: "样本7", paths: [], potency: 0.8, source: "manual", tags: [] });
  seedRound(store7, m7.id, 0);
  store7.adapt(Date.now() + 8 * DAY); // 0.94
  seedRound(store7, m7.id, 0);
  store7.adapt(Date.now() + 16 * DAY); // 0.93
  seedRound(store7, m7.id, 0);
  store7.adapt(Date.now() + 24 * DAY); // 0.92
  seedRound(store7, m7.id, 0);
  store7.adapt(Date.now() + 32 * DAY); // 0.91
  seedRound(store7, m7.id, 0);
  store7.adapt(Date.now() + 40 * DAY); // 0.90
  seedRound(store7, m7.id, 0);
  store7.adapt(Date.now() + 48 * DAY); // 下限封顶
  assert(store7.getActiveDecayFactor() === 0.9, "收紧下限封顶 0.90");

  // 调整后的衰减系数实际生效于 applyDecay
  const store8 = createTestStore();
  const m8 = store8.add({ type: "fact", content: "样本8", paths: [], potency: 0.8, source: "manual", tags: [] });
  for (let i = 0; i < 40; i++) store8.registerInjection(m8.id);
  store8.adapt(Date.now() + 8 * DAY); // 收紧到 0.94
  store8.update(m8.id, { lastDecayedAt: Date.now() - 10 * DAY });
  store8.applyDecay();
  const p8 = store8.getById(m8.id)!.potency;
  assert(Math.abs(p8 - 0.8 * Math.pow(0.94, 10)) < 0.001, `收紧后衰减更快生效 (0.94^10 衰减, 得 ${p8.toFixed(3)})`);
}

// ─── 3. 持久化：反馈与统计跨重启保留 ───
function testPersistence() {
  console.log("\n📋 测试: 闭环反馈与自寻最优统计持久化");

  const path = `/tmp/pi-memory-cyber-persist-${Date.now()}-${Math.random()}.json`;
  const store = new MemoryStore({ storePath: path, config: { decayFactor: 0.95 } });
  const m = store.add({ type: "preference", content: "偏好中文", paths: [], potency: 0.6, source: "manual", tags: [] });
  for (let i = 0; i < 40; i++) store.registerInjection(m.id);
  store.save();
  store.mutate(() => store.registerRecallHits([m.id]));
  store.adapt(Date.now() + 8 * DAY);
  store.save();

  const reloaded = new MemoryStore({ storePath: path, config: { decayFactor: 0.95 } });
  const rm = reloaded.getById(m.id)!;
  assert(rm.recallHitCount === 1, "recallHitCount 持久化保留");
  assert(Math.abs(rm.potency - 0.63) < 1e-9, "命中强化后的 potency 持久化保留");
  const s = (reloaded as any).data.adaptation;
  assert(s.injections === 0 && s.recallHits === 0 && s.windowStart > 0, "自适应统计窗口已重置并持久化");
}

// ─── 运行全部测试 ───
console.log("🧪 工程控制论改造测试（闭环反馈 + 自寻最优）");
console.log("=".repeat(52));

testRecallFeedback();
testAdaptation();
testPersistence();

console.log("\n" + "=".repeat(52));
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
