/**
 * Memory Store 核心测试 — 间隔重复算法 + CRUD
 *
 * 纯 Node.js 测试，不依赖任何测试框架。
 * 运行: node __tests__/store.test.ts
 */

import { MemoryStore } from "../src/store.ts";
import { generateIndexMd } from "../src/index-md.ts";

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

// 每个测试使用独立的 store，避免互相干扰
function createTestStore(): MemoryStore {
  return new MemoryStore({
    storePath: `/tmp/pi-memory-test-${Date.now()}-${Math.random()}.json`,
    config: { decayFactor: 0.95 },
  });
}

// ─── 1. 基本 CRUD ───
function testCRUD() {
  console.log("\n📋 测试: 基本 CRUD");

  const store = createTestStore();
  assert(store.getAll().length === 0, "新 store 应该为空");

  const m1 = store.add({ type: "decision", content: "使用 JWT 认证", paths: ["src/auth/"], potency: 0.8, source: "manual", tags: ["auth"] });
  assert(store.getAll().length === 1, "添加后条目数为 1");
  assert(m1.id.startsWith("mem_"), "ID 格式正确");
  assert(m1.potency === 0.8, "初始 potency 正确");
  assert(m1.accessCount === 0, "初始 accessCount 为 0");

  const found = store.getById(m1.id);
  assert(found !== undefined, "getById 能找到");

  store.remove(m1.id);
  assert(store.getAll().length === 0, "删除后条目数为 0");
}

// ─── 2. 间隔重复 — 衰减 ───
function testDecay() {
  console.log("\n📋 测试: 间隔重复衰减");

  const store = createTestStore();
  const m = store.add({ type: "fact", content: "Node.js >= 18", paths: [], potency: 0.8, source: "manual", tags: [] });

  // 修改衰减基准为 2 天前
  const twoDaysAgo = Date.now() - 2 * 86_400_000;
  store.update(m.id, { lastInjectedAt: twoDaysAgo, lastDecayedAt: twoDaysAgo });

  store.applyDecay();
  const after = store.getById(m.id)!;
  assert(after.potency < 0.8, "衰减后 potency 降低");
  assert(after.potency > 0, "衰减后 potency 大于 0");

  // 用新条目测试更长时间的衰减
  const m2 = store.add({ type: "fact", content: "test2", paths: [], potency: 0.8, source: "manual", tags: [] });
  const tenDaysAgo = Date.now() - 10 * 86_400_000;
  store.update(m2.id, { lastInjectedAt: tenDaysAgo, lastDecayedAt: tenDaysAgo });
  store.applyDecay();
  const afterLong = store.getById(m2.id)!;
  assert(afterLong.potency < store.getById(m.id)!.potency, "10 天未使用比 2 天未使用衰减更多");
}

// ─── 3. 间隔重复 — 注入只计数不强化（强化仅来自新独立证据）───
function testInjectionBoost() {
  console.log("\n📋 测试: 注入只累计使用，不强化 potency、不重置衰减锚点");

  const store = createTestStore();
  const m = store.add({ type: "decision", content: "test", paths: [], potency: 0.5, source: "manual", tags: [] });
  const decayAnchor = store.getById(m.id)!.lastDecayedAt;

  store.registerInjection(m.id);
  const after = store.getById(m.id)!;
  assert(after.potency === 0.5, "注入后 potency 不变（注入不是新证据）");
  assert(after.accessCount === 1, "注入计数增加");
  assert(after.lastDecayedAt === decayAnchor, "注入不重置衰减锚点，记忆仍会随时间衰减");

  // 反复注入也不会涨 potency
  for (let i = 0; i < 5; i++) store.registerInjection(m.id);
  const afterMany = store.getById(m.id)!;
  assert(afterMany.potency === 0.5, "多次注入 potency 仍不变");
  assert(afterMany.accessCount === 6, "注入计数累计到 6");
}

// ─── 4. 路径关联查询 ───
function testPathRelevance() {
  console.log("\n📋 测试: 路径关联检索");

  const store = createTestStore();
  store.add({ type: "decision", content: "Auth 用 JWT", paths: ["src/auth/login.ts"], potency: 0.5, source: "manual", tags: [] });
  store.add({ type: "convention", content: "数据库用 Prisma", paths: ["src/db/schema.prisma"], potency: 0.9, source: "manual", tags: [] });
  store.add({ type: "fact", content: "通用约定", paths: [], potency: 0.6, source: "manual", tags: [] });

  // 查询关联 src/auth/ 的记忆
  const relevant = store.getRelevantToPaths(["src/auth/login.ts"], 5);
  assert(relevant.length > 0, "路径关联能查到结果");
  assert(relevant[0].content.includes("JWT"), "关联排序中 Auth 条目优先");

  // 查询无关联路径
  const irrelevant = store.getRelevantToPaths(["src/unknown/file.ts"], 5);
  assert(irrelevant.length === 0, "无路径命中时不混入普通 Top-N");
}

// ─── 5. 搜索 ───
function testSearch() {
  console.log("\n📋 测试: 关键词搜索");

  const store = createTestStore();
  store.add({ type: "fact", content: "使用 pnpm 管理依赖", paths: [], potency: 0.8, source: "manual", tags: ["pnpm", "package-manager"] });
  store.add({ type: "fact", content: "使用 npm 管理依赖", paths: [], potency: 0.8, source: "manual", tags: ["npm"] });

  const results = store.search("pnpm");
  assert(results.length === 1, "搜索 pnpm 找到 1 条");
  assert(results[0].content.includes("pnpm"), "搜索结果内容匹配");

  const all = store.search("依赖");
  assert(all.length === 2, "搜索 依赖 找到 2 条");
}

// ─── 6. 相似度与冲突检测 ───
function testSimilarityAndConflict() {
  console.log("\n📋 测试: 相似度与冲突检测");

  const store = createTestStore();
  store.add({ type: "decision", content: "使用 JWT + Refresh Token 做用户认证", paths: [], potency: 0.8, source: "manual", tags: [] });

  // 相似内容
  const conflicts1 = store.findConflicts("使用 JWT 和 Refresh Token 进行用户认证", 0.5);
  assert(conflicts1.length > 0, "相似内容被检测到");

  // 不同内容
  const conflicts2 = store.findConflicts("数据库使用 PostgreSQL", 0.5);
  assert(conflicts2.length === 0, "不同内容被判定为不冲突");
}

// ─── 7. Top-N 排序 ───
function testTopN() {
  console.log("\n📋 测试: Top-N 排序");

  const store = createTestStore();
  store.add({ type: "fact", content: "低优先级", paths: [], potency: 0.3, source: "manual", tags: [] });
  store.add({ type: "fact", content: "高优先级", paths: [], potency: 0.9, source: "manual", tags: [] });
  store.add({ type: "fact", content: "中优先级", paths: [], potency: 0.6, source: "manual", tags: [] });

  const top2 = store.getTopN(2);
  assert(top2.length === 2, "Top-N 返回正确数量");
  assert(top2[0].content === "高优先级", "Top-1 为最高 potency");
  assert(top2[1].content === "中优先级", "Top-2 为次高 potency");
}

// ─── 8. MEMORY.md 生成 ───
function testMemoryMd() {
  console.log("\n📋 测试: MEMORY.md 生成");

  const store = createTestStore();
  store.add({ type: "decision", content: "JWT 认证方案认证方案认证方案", paths: [], potency: 0.9, source: "manual", tags: ["auth"] });
  store.add({ type: "convention", content: "Prisma ORM", paths: [], potency: 0.7, source: "manual", tags: ["database"] });

  const data = { version: 1, updatedAt: Date.now(), memories: store.getAll() };
  const md = generateIndexMd(data);

  assert(md.includes("JWT 认证方案"), "INDEX.md 包含记忆内容");
  assert(md.includes("Prisma ORM"), "INDEX.md 包含记忆内容");
  assert(md.includes("auth"), "INDEX.md 包含主题标签");
  assert(md.includes("database"), "INDEX.md 包含主题标签");
  assert(md.includes("高优先级记忆"), "INDEX.md 包含优先级标题");
}

// ─── 9. 持久化 ───
function testPersistence() {
  console.log("\n📋 测试: 持久化");

  const path = `/tmp/pi-memory-persist-${Date.now()}.json`;
  const store1 = new MemoryStore({ storePath: path });
  store1.add({ type: "fact", content: "持久化测试", paths: [], potency: 0.8, source: "manual", tags: [] });
  store1.save();

  const store2 = new MemoryStore({ storePath: path });
  assert(store2.getAll().length === 1, "重新加载后条目数正确");
  assert(store2.getAll()[0].content === "持久化测试", "重新加载后内容正确");
}

// ─── 10. 归档过滤 ───
function testArchive() {
  console.log("\n📋 测试: 三级分类（活跃/低效/归档）");

  const store = createTestStore();
  store.add({ type: "fact", content: "活跃记忆", paths: [], potency: 0.8, source: "manual", tags: [] });
  store.add({ type: "fact", content: "低效记忆", paths: [], potency: 0.25, source: "manual", tags: [] });
  store.add({ type: "fact", content: "归档记忆", paths: [], potency: 0.15, source: "manual", tags: [] });

  assert(store.getActive().length === 1, "活跃: 只有 0.8 的");
  assert(store.getLowEfficiency().length === 1, "低效: 0.20~0.30 的 1 条");
  assert(store.getArchived().length === 1, "归档: 低于 0.20 的 1 条");
  assert(store.getInjectable().length === 2, "可注入: 活跃和低效共 2 条");

  store.applyDecay();
  assert(store.getAll().length === 3, "衰减后归档记忆仍保留");
  assert(store.getInjectable().length === 2, "归档记忆不可注入");
}

// ─── 11. 中文相似度（2-gram Dice）───
function testChineseSimilarity() {
  console.log("\n📋 测试: 中文相似度");

  const store = createTestStore();
  // 完全相同
  assert(store.similarity("用户偏好清晰直观的界面", "用户偏好清晰直观的界面") === 1, "纯中文相同 → 1.0");
  // 近义（真实重复样本：同一事实、详略不同，overlap ≈0.52）
  const simNear = store.similarity(
    "提取器需要在同一批次内做去重：相似度 >=85% 视为重复跳过，避免 LLM 一次返回多条相似内容导致重复记忆。同时需要记录已解决冲突的哈希，防止 agent_settled 时重新加入。",
    "提取器在同批次内对 LLM 返回的多个事实做相似度去重（≥85% 视为重复跳过），避免同一段对话提取出多条相似记忆。",
  );
  assert(simNear >= 0.45, `近义中文应 ≥0.45（实际 ${simNear.toFixed(2)}）`);
  // 无关
  const simDiff = store.similarity("这个项目使用 pnpm 作为包管理器", "记忆注入采用路径关联的宫殿机制");
  assert(simDiff < 0.4, `无关内容应 <0.4（实际 ${simDiff.toFixed(2)}）`);
  // 包含关系
  assert(store.similarity("使用 pnpm 作为包管理器", "这个项目使用 pnpm 作为包管理器") === 1, "包含关系 → 1.0");
  // 归一化：标点/空白差异不影响精确匹配
  assert(store.similarity("记住： 这个项目，用 pnpm！", "记住这个项目用pnpm") === 1, "标点空白归一化后相同 → 1.0");
}

// ─── 12. 入库闸门 dedupeCheck ───
function testDedupeGate() {
  console.log("\n📋 测试: 入库闸门 dedupeCheck");

  const store = createTestStore();
  store.add({ type: "lesson", content: "提取器需要在同一批次内做去重：相似度 >=85% 视为重复跳过，避免 LLM 一次返回多条相似内容导致重复记忆。同时需要记录已解决冲突的哈希，防止 agent_settled 时重新加入。", paths: [], potency: 0.8, source: "manual", tags: [] });

  // exact
  const exact = store.dedupeCheck("提取器需要在同一批次内做去重：相似度 >=85% 视为重复跳过，避免 LLM 一次返回多条相似内容导致重复记忆。同时需要记录已解决冲突的哈希，防止 agent_settled 时重新加入。");
  assert(exact.level === "exact", "完全相同 → exact");

  // high / mid（真实近义样本，实测 overlap ≈0.52）
  const near = store.dedupeCheck("提取器在同批次内对 LLM 返回的多个事实做相似度去重（≥85% 视为重复跳过），避免同一段对话提取出多条相似记忆。");
  assert(near.level === "high" || near.level === "mid", `近义 → high/mid（实际 ${near.level} ${near.matches[0]?.similarity.toFixed(2)}）`);

  // none
  const none = store.dedupeCheck("燕麦多孔淀粉制备工艺研究");
  assert(none.level === "none", "无关内容 → none");

  // 已归档记忆也参与查重
  const store2 = createTestStore();
  const m = store2.add({ type: "fact", content: "一条快要被遗忘的记忆事实", paths: [], potency: 0.05, source: "auto", tags: [] });
  assert(store2.getAll().some((x) => x.id === m.id), "前置条件：该记忆存在");
  const low = store2.dedupeCheck("一条快要被遗忘的记忆事实");
  assert(low.level === "exact", "低效记忆也能被闸门命中防重复");
}

// ─── 13. 存量去重 dedupeAll（自动合并）───
function testDedupeAll() {
  console.log("\n📋 测试: 存量去重 dedupeAll（自动合并，无冲突）");

  const store = createTestStore();
  // 精确重复（标点差异，归一化后相同），低 potency 的应被合并
  const low = store.add({ type: "lesson", content: "MemSpacedCard 直接读写 memory-store.json 作为唯一数据源。", paths: ["/a.ts"], potency: 0.5, source: "auto", tags: ["a"] });
  const high = store.add({ type: "fact", content: "MemSpacedCard直接读写memory-store.json作为唯一数据源", paths: ["/b.ts"], potency: 0.8, source: "manual", tags: ["b"] });
  store.add({ type: "fact", content: "完全独立的另一条记忆内容", paths: [], potency: 0.7, source: "auto", tags: [] });

  const result = store.dedupeAll();
  assert(result.merged === 1, `合并 1 条精确重复（实际 ${result.merged}）`);
  assert(store.getAll().length === 2, "剩余 2 条记忆");
  const keeper = store.getById(high.id);
  assert(keeper !== undefined, "保留 potency 高者");
  assert(store.getById(low.id) === undefined, "低 potency 重复被移除");
  assert(keeper!.paths.includes("/a.ts") && keeper!.paths.includes("/b.ts"), "paths 取并集");
  assert(keeper!.tags.includes("a") && keeper!.tags.includes("b"), "tags 取并集");

  // 中相似（0.45~0.8，重复率较小）→ 不合并，允许并存
  const store2 = createTestStore();
  store2.add({ type: "decision", content: "冲突解决按钮统一为三个：合并、另存、不采纳", paths: [], potency: 0.8, source: "auto", tags: [] });
  store2.add({ type: "decision", content: "冲突解决操作确定为三个按钮：合并、另存、不采纳", paths: [], potency: 0.6, source: "auto", tags: [] });
  const r2 = store2.dedupeAll();
  assert(r2.merged === 0, `中相似不合并（实际 merged=${r2.merged}）`);
  assert(store2.getAll().length === 2, "两条均保留");

  // 极高相似也可能是纠正或否定，只自动合并精确重复
  const store3 = createTestStore();
  store3.add({ type: "decision", content: "存量去重只自动合并精确重复记忆，高相似项保留。", paths: ["/a.ts"], potency: 0.8, source: "auto", tags: [] });
  store3.add({ type: "decision", content: "存量去重只自动合并精确重复的记忆，高相似项保留", paths: ["/b.ts"], potency: 0.6, source: "auto", tags: [] });
  const r4 = store3.dedupeAll();
  assert(r4.merged === 0, `非精确内容不自动合并（实际 merged=${r4.merged}）`);
  assert(store3.getAll().length === 2, "两条高相似内容均保留");

  // 相关但不同的存量记忆（<0.55）→ 不合并
  const store4 = createTestStore();
  store4.add({ type: "fact", content: "记忆数据持久化在 ~/.pi/agent/memory-store.json，索引文件为同一目录下的 INDEX.md", paths: [], potency: 0.8, source: "auto", tags: [] });
  store4.add({ type: "lesson", content: "修改运行中插件的内存数据或 memory-store.json 无效：源码修改需重启 PiDeck 加载新代码", paths: [], potency: 0.8, source: "auto", tags: [] });
  const r5 = store4.dedupeAll();
  assert(r5.merged === 0, "相关但不同的记忆不合并（<0.55）");
}

// ─── 14. 表驱动：相似偏好重复表达只保留一条（强化不新增）───
function testReinforcementTable() {
  console.log("\n📋 测试: 相似偏好重复表达只保留一条");

  // 三个相似度级别：exact / high(≥0.8) / mid(≥0.45) → 都应强化旧条目而非新增
  const cases = [
    { name: "exact 归一化相同", a: "改代码前先跑测试", b: "改代码前先跑测试" },
    { name: "high 高度相似", a: "用户偏好改代码前先运行测试", b: "用户偏好改代码前先运行测试，再检查覆盖率" },
    { name: "mid 相关但不同表述", a: "修改课件前先与老师确认大纲", b: "制作课件前先确认大纲和配色再动手" },
  ];

  for (const c of cases) {
    const store = createTestStore();
    const first = store.add({ type: "preference", content: c.a, paths: [], potency: 0.8, source: "auto", tags: [] });
    const check = store.dedupeCheck(c.b);
    assert(check.level !== "none", `${c.name}：相似度检测命中（${check.level}）`);
    if (check.level !== "none") {
      const existing = check.matches[0].entry;
      store.update(existing.id, {
        potency: Math.min(1, existing.potency + 0.01),
        evidenceCount: (existing.evidenceCount ?? 1) + 1,
      });
    }
    assert(store.getAll().length === 1, `${c.name}：重复表达后仍只有 1 条`);
    assert((store.getById(first.id)?.evidenceCount ?? 1) === 2, `${c.name}：evidenceCount 累计为 2`);
    assert(store.getById(first.id)?.potency === 0.81, `${c.name}：potency 仅微量强化 0.01`);
  }

  // 未匹配（<0.45）→ 正常新增
  const store = createTestStore();
  store.add({ type: "preference", content: "用户偏好使用中文沟通", paths: [], potency: 0.8, source: "auto", tags: [] });
  const noMatch = store.dedupeCheck("PPT 汇报用深色背景配金色标题");
  assert(noMatch.level === "none", "不相关内容不命中，允许新增");
}

// ─── 15. 归档边界：阈值恰好相等时行为固定（< 0.2 归档，≥ 0.2 可注入）───
function testArchiveBoundary() {
  console.log("\n📋 测试: 归档边界（0.2 精确值）");

  const store = createTestStore();
  store.add({ type: "fact", content: "边界 0.20", paths: [], potency: 0.2, source: "manual", tags: [] });
  store.add({ type: "fact", content: "边界 0.19", paths: [], potency: 0.19, source: "manual", tags: [] });
  const archiveThreshold = store.getConfig().archiveThreshold;
  assert(archiveThreshold === 0.2, "归档阈值配置为 0.20");
  assert(store.getArchived().length === 1, "0.19 归档、0.20 不归档");
  assert(store.getArchived()[0].content === "边界 0.19", "恰好 0.19 属于归档");
  assert(store.getInjectable().length === 1, "恰好 0.20 仍可注入（>= 归档线）");
  assert(store.getInjectable()[0].content === "边界 0.20", "可注入集合含 0.20 边界");

  // 衰减后跌破归档线 → 自动转为不可注入
  const store2 = createTestStore();
  const m = store2.add({ type: "fact", content: "将归档的记忆", paths: [], potency: 0.8, source: "manual", tags: [] });
  const base = Date.now();
  store2.update(m.id, { lastDecayedAt: base - 40 * 86_400_000 });
  store2.applyDecay(base);
  const p = store2.getById(m.id)!.potency;
  assert(p < 0.2, `衰减 40 天后 potency=${p.toFixed(3)} 跌破 0.2`);
  assert(store2.getArchived().some((x) => x.id === m.id), "跌破归档线后进入归档集合");
  assert(!store2.getInjectable().some((x) => x.id === m.id), "归档记忆不可注入");
}

// ─── 运行全部测试 ───
console.log("🧪 pi-memory-spaced 核心测试");
console.log("=".repeat(40));

testCRUD();
testDecay();
testInjectionBoost();
testPathRelevance();
testSearch();
testSimilarityAndConflict();
testChineseSimilarity();
testDedupeGate();
testDedupeAll();
testTopN();
testMemoryMd();
testPersistence();
testArchive();
testReinforcementTable();
testArchiveBoundary();

console.log("\n" + "=".repeat(40));
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
