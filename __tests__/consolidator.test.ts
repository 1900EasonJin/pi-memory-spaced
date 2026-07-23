/**
 * Memory Consolidator 测试 — 聚类 + dry-run + 落库合并
 *
 * 运行: node --experimental-strip-types __tests__/consolidator.test.ts
 */

import { existsSync } from "node:fs";
import { MemoryStore } from "../src/store.ts";
import { MemoryConsolidator } from "../src/consolidator.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function createStore(): { store: MemoryStore; backupPath: string } {
  const storePath = `/tmp/pi-memory-consolidator-test-${Date.now()}-${Math.random()}.json`;
  const store = new MemoryStore({ storePath });
  return { store, backupPath: storePath.replace(/\.json$/, ".backup.json") };
}

/** 假 LLM：返回固定合并结果 */
const mockModel = { provider: "mock" };
const mockRegistry: any = {
  getProvider: () => ({
    streamSimple: () => ({
      result: async () => ({
        content: [{ type: "text", text: '{ "mergedContent": "用户偏好PPT主标题18-20px，中心词26px，正文紧凑" }' }],
      }),
    }),
  }),
  getProviderAuth: async () => ({ auth: { apiKey: "fake" }, env: {} }),
};

function seedCluster(store: MemoryStore): void {
  store.add({ type: "preference", content: "PPT字体大小偏好：主标题约18-20px，正文紧凑，中心词约26px", paths: ["ppt/"], potency: 0.8, source: "auto", tags: ["ppt"] });
  store.add({ type: "preference", content: "PPT字体偏好：主标题18-20px，中心词26px，分支标题约18px", paths: ["slides/"], potency: 0.7, source: "auto", tags: ["ppt", "font"] });
  // 无关记忆，不应入簇
  store.add({ type: "fact", content: "飞书按钮应放置在模型选择器左侧", paths: [], potency: 0.8, source: "auto", tags: [] });
  // user 来源的高相似记忆，不应参与自动合并
  store.add({ type: "preference", content: "PPT字体大小偏好：主标题18-20px，正文要紧凑", paths: [], potency: 0.9, source: "user", tags: [] });
}

// ─── 1. 聚类 ───
function testFindClusters() {
  console.log("\n📋 测试: 聚类");
  const { store } = createStore();
  seedCluster(store);

  const clusters = new MemoryConsolidator(store).findClusters();
  assert(clusters.length === 1, `应找到 1 个簇，实际 ${clusters.length}`);
  assert(clusters[0]?.length === 2, `簇内应为 2 条（user 来源被排除），实际 ${clusters[0]?.length}`);
  assert(!clusters[0]?.some((m) => m.source === "user"), "簇内不含 user 来源记忆");
}

// ─── 2. dry-run 不写库 ───
async function testDryRun() {
  console.log("\n📋 测试: dry-run");
  const { store, backupPath } = createStore();
  seedCluster(store);
  store.save();
  const before = store.getAll().length;

  const result = await new MemoryConsolidator(store).consolidate(mockRegistry, "test-session", mockModel, { dryRun: true });
  assert(result.plans.length === 1, `应产生 1 个合并计划，实际 ${result.plans.length}`);
  assert(result.plans[0]?.mergedContent.includes("PPT"), "计划包含合并内容");
  assert(result.merged === 0 && result.removed === 0, "dry-run 不落库");
  assert(store.getAll().length === before, "dry-run 后条目数不变");
  assert(!existsSync(backupPath), "dry-run 不产生备份");
}

// ─── 3. 实际合并落库 ───
async function testConsolidate() {
  console.log("\n📋 测试: 落库合并");
  const { store, backupPath } = createStore();
  seedCluster(store);
  store.save();

  const result = await new MemoryConsolidator(store).consolidate(mockRegistry, "test-session", mockModel);
  assert(result.merged === 1 && result.removed === 2, `合并 2→1，实际 merged=${result.merged} removed=${result.removed}`);

  const all = store.getAll();
  assert(all.length === 3, `总数 4-2+1=3，实际 ${all.length}`); // 合并条 + 飞书 + user
  const merged = all.find((m) => m.content.includes("中心词26px") && m.source === "auto");
  assert(!!merged, "存在合并后的新条目");
  assert(merged!.paths.includes("ppt/") && merged!.paths.includes("slides/"), "paths 取并集");
  assert(merged!.tags.includes("font"), "tags 取并集");
  assert(merged!.potency === 0.8, "potency 取簇内最大值");
  assert(all.some((m) => m.source === "user"), "user 来源记忆保留");
  assert(existsSync(backupPath), "落库前生成备份");
}

// ─── 4. LLM 失败时不做任何修改 ───
async function testLlmFailure() {
  console.log("\n📋 测试: LLM 失败保护");
  const { store } = createStore();
  seedCluster(store);
  store.save();
  const failRegistry: any = {
    getProvider: () => ({ streamSimple: () => ({ result: async () => { throw new Error("boom"); } }) }),
    getProviderAuth: async () => ({ auth: { apiKey: "fake" }, env: {} }),
  };

  const before = store.getAll().length;
  const result = await new MemoryConsolidator(store).consolidate(failRegistry, "s", mockModel);
  assert(result.merged === 0, "失败时不合并");
  assert(store.getAll().length === before, "失败时条目数不变");
}

// ─── 5. LLM 否决：判定不应合并时跳过 ───
async function testLlmVeto() {
  console.log("\n📋 测试: LLM 否决权");
  const { store } = createStore();
  seedCluster(store);
  store.save();
  const vetoRegistry: any = {
    getProvider: () => ({
      streamSimple: () => ({
        result: async () => ({ content: [{ type: "text", text: '{ "mergedContent": null }' }] }),
      }),
    }),
    getProviderAuth: async () => ({ auth: { apiKey: "fake" }, env: {} }),
  };

  const before = store.getAll().length;
  const result = await new MemoryConsolidator(store).consolidate(vetoRegistry, "s", mockModel);
  assert(result.plans.length === 0 && result.merged === 0, "否决后不产生计划、不合并");
  assert(store.getAll().length === before, "否决后条目数不变");
}

async function main() {
  testFindClusters();
  await testDryRun();
  await testConsolidate();
  await testLlmFailure();
  await testLlmVeto();
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
