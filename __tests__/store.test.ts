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
    config: { decayFactor: 0.5 }, // 加速衰减，方便测试
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

  // 修改 lastInjectedAt 为 2 天前
  store.update(m.id, { lastInjectedAt: Date.now() - 2 * 86_400_000 });

  store.applyDecay();
  const after = store.getById(m.id)!;
  assert(after.potency < 0.8, "衰减后 potency 降低");
  assert(after.potency > 0, "衰减后 potency 大于 0");

  // 用新条目测试更长时间的衰减
  const m2 = store.add({ type: "fact", content: "test2", paths: [], potency: 0.8, source: "manual", tags: [] });
  store.update(m2.id, { lastInjectedAt: Date.now() - 10 * 86_400_000 });
  store.applyDecay();
  const afterLong = store.getById(m2.id)!;
  assert(afterLong.potency < store.getById(m.id)!.potency, "10 天未使用比 2 天未使用衰减更多");
}

// ─── 3. 间隔重复 — 注入提升 ───
function testInjectionBoost() {
  console.log("\n📋 测试: 注入 potency 提升");

  const store = createTestStore();
  const m = store.add({ type: "decision", content: "test", paths: [], potency: 0.5, source: "manual", tags: [] });

  store.registerInjection(m.id);
  const after = store.getById(m.id)!;
  assert(after.potency > 0.5, "注入后 potency 提升");
  assert(after.accessCount === 1, "注入计数增加");
  assert(after.lastInjectedAt > 0, "注入时间更新");

  // 多次注入不超 1.0
  for (let i = 0; i < 5; i++) store.registerInjection(m.id);
  const afterMany = store.getById(m.id)!;
  assert(afterMany.potency <= 1.0, "多次注入不超 1.0");
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
  assert(irrelevant.length > 0, "即使无关联也返回通用记忆");
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

  const data = { version: 1, updatedAt: Date.now(), memories: store.getAll(), conflicts: store.getConflicts() };
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

// ─── 10. 归档 ───
function testArchive() {
  console.log("\n📋 测试: 归档");

  const store = createTestStore();
  store.add({ type: "fact", content: "活跃记忆", paths: [], potency: 0.8, source: "manual", tags: [] });
  store.add({ type: "fact", content: "低分活跃", paths: [], potency: 0.15, source: "manual", tags: [] });

  const active = store.getActive();
  assert(active.length === 2, "两条都在活跃列表中（threshold=0.1）");

  // 增加一条低于 threshold 的
  store.add({ type: "fact", content: "已归档", paths: [], potency: 0.05, source: "manual", tags: [] });
  assert(store.getActive().length === 2, "归档条目不在活跃列表中");
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
testTopN();
testMemoryMd();
testPersistence();
testArchive();

console.log("\n" + "=".repeat(40));
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
