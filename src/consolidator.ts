/**
 * Memory Consolidator — 语义整合器
 *
 * 把相似记忆聚类后由 LLM 合并成一条更完整的记忆，解决
 * 「mid 档（0.45~0.8）相关记忆只增不合」导致的堆积问题。
 *
 * 安全规则：
 * - source === "user"（口语「记住：」）不参与自动合并；固化记忆可参与，
 *   合并结果继承 tenured 标记与 accessCount 总和（固化不等于不可整理）
 * - 落库前自动备份 memory-store.json → memory-store.backup.json
 * - LLM 失败或返回非法结果时跳过该簇，不做任何修改
 * - dryRun 模式只返回合并计划，不写库
 */

import { copyFileSync, existsSync } from "node:fs";
import type { MemoryStore } from "./store.ts";
import type { MemoryEntry } from "./types.ts";
import { callSimpleLLM } from "./extractor.ts";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** 聚类阈值：低于入库闸门 mid 档（0.45），靠 LLM 否决权兜底误聚 */
const CLUSTER_THRESHOLD = 0.3;
/** 单簇最大条数，超出说明阈值失效，避免巨型合并 */
const MAX_CLUSTER_SIZE = 8;

const CONSOLIDATE_PROMPT = `你是一个记忆整合器。下面给出若干条语义相近的记忆，它们描述的是同一主题的不同侧面。

请把它们合并成一条更完整、更准确的记忆，要求：
1. 不超过 200 字，一句话或短句组合
2. 保留所有不冲突的具体信息（数字、路径、偏好细节）
3. 如果条目之间存在纠正或冲突关系，保留更新的表述；标着 [用户明确指令] 的条目措辞优先
4. 不要引入条目中没有的信息
5. 如果这些记忆实际上不是同一主题、不应该合并，返回 { "mergedContent": null }

以 JSON 格式返回，不要包含其他内容：
{ "mergedContent": "合并后的记忆内容" }`;

export interface ConsolidationPlan {
  /** 将被删除的旧条目 */
  removed: MemoryEntry[];
  /** 合并后的新内容 */
  mergedContent: string;
}

export interface ConsolidationResult {
  dryRun: boolean;
  plans: ConsolidationPlan[];
  /** 实际落库时：合并产生的条数 / 删除的条数 */
  merged: number;
  removed: number;
}

export class MemoryConsolidator {
  private store: MemoryStore;
  private running = false;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /**
   * 相似度聚类（并查集）。只返回 ≥2 条的簇。
   * 仅 user 来源不参与（口语「记住：」优先级最高，措辞不应被 LLM 改写）；
   * 固化记忆参与聚类——它们恰是长期堆积的主体。
   */
  findClusters(): MemoryEntry[][] {
    const candidates = this.store.getActive().filter((m) => m.source !== "user");
    const parent = candidates.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        if (find(i) !== find(j) && this.store.similarity(candidates[i].content, candidates[j].content) >= CLUSTER_THRESHOLD) {
          parent[find(i)] = find(j);
        }
      }
    }

    const groups = new Map<number, MemoryEntry[]>();
    candidates.forEach((m, i) => {
      const root = find(i);
      groups.set(root, [...(groups.get(root) ?? []), m]);
    });
    return [...groups.values()].filter((g) => g.length >= 2 && g.length <= MAX_CLUSTER_SIZE);
  }

  /** 用 LLM 为一簇记忆生成合并计划；失败返回 null。 */
  private async planCluster(
    cluster: MemoryEntry[],
    modelRegistry: ModelRegistry,
    model: any,
  ): Promise<ConsolidationPlan | null> {
    const provider = modelRegistry.getProvider(model.provider);
    const auth = await modelRegistry.getProviderAuth(model.provider);
    if (!provider || !auth || !model) return null;

    const lines = cluster
      .map((m) => {
        const tag = m.source === "manual" ? "[手动添加] " : "";
        return `- ${tag}${m.content}`;
      })
      .join("\n");
    const text = await callSimpleLLM(model, provider, auth, CONSOLIDATE_PROMPT, `【待合并记忆】\n${lines}`);
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]);
      // LLM 否决权：判定不应合并时返回 null，跳过该簇
      if (parsed.mergedContent === null) return null;
      if (typeof parsed.mergedContent !== "string" || parsed.mergedContent.trim().length < 10) return null;
      return { removed: cluster, mergedContent: parsed.mergedContent.trim().slice(0, 500) };
    } catch {
      return null;
    }
  }

  /**
   * 执行整合。dryRun=true 时只返回计划不写库。
   */
  async consolidate(
    modelRegistry: ModelRegistry,
    sessionId: string,
    model: any,
    opts?: { dryRun?: boolean },
  ): Promise<ConsolidationResult> {
    const dryRun = opts?.dryRun ?? false;
    if (this.running || !model) return { dryRun, plans: [], merged: 0, removed: 0 };

    this.running = true;
    try {
      this.store.reloadIfChanged();
      const clusters = this.findClusters();
      const plans: ConsolidationPlan[] = [];
      for (const cluster of clusters) {
        const plan = await this.planCluster(cluster, modelRegistry, model);
        if (plan) plans.push(plan);
      }
      if (dryRun || plans.length === 0) return { dryRun, plans, merged: 0, removed: 0 };

      // 落库前备份（覆盖式，只留一份）
      const storePath = this.store.getStorePath();
      if (existsSync(storePath)) copyFileSync(storePath, storePath.replace(/\.json$/, ".backup.json"));

      return this.store.mutate(() => {
        let merged = 0;
        let removed = 0;
        for (const plan of plans) {
          // mutate 重载过磁盘，条目可能已被外部改动；逐条确认仍存在再删
          const alive = plan.removed.filter((m) => this.store.getById(m.id));
          if (alive.length < 2) continue;

          const addedEntry = this.store.add({
            type: alive[0].type,
            content: plan.mergedContent,
            paths: [...new Set(alive.flatMap((m) => m.paths))].slice(0, 20),
            potency: Math.max(...alive.map((m) => m.potency)),
            source: "auto",
            tags: [...new Set(alive.flatMap((m) => m.tags))].slice(0, 5),
            sourceSession: sessionId,
          });
          // 继承固化状态与累计注入次数：簇内任一条固化则结果固化
          const totalAccess = alive.reduce((sum, m) => sum + m.accessCount, 0);
          const anyTenured = alive.some((m) => m.tenured);
          if (anyTenured || totalAccess > 0) {
            this.store.update(addedEntry.id, { accessCount: totalAccess, tenured: anyTenured || undefined });
          }
          for (const m of alive) this.store.remove(m.id);
          merged++;
          removed += alive.length;
        }
        this.store.dedupeAll();
        return { dryRun, plans, merged, removed };
      });
    } finally {
      this.running = false;
    }
  }
}
