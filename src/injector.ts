import type { MemoryStore } from "./store";
import type { MemoryEntry } from "./types";
import { DEFAULT_INJECTION_CONFIG } from "./types";

/** 估算一段文本的 token 数（粗略：中文字符*1.5，英文单词*1.3） */
function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) tokens += 1.5;
    else if (/\s/.test(ch)) tokens += 0.25;
    else tokens += 0.3;
  }
  return Math.ceil(tokens);
}

export interface InjectionSnapshot {
  /** 注入文本 */
  text: string;
  /** 被注入的记忆 id 列表 */
  injectedIds: string[];
  /** 预算使用量 */
  tokensUsed: number;
}

/**
 * 从 store 中选出要注入的记忆，打包成 systemPrompt 片段。
 * 使用 snapshot 机制：同一 session 内多次调用返回相同结果（直到手动刷新）。
 */
export class MemoryInjector {
  private store: MemoryStore;
  private snapshot: InjectionSnapshot | null = null;
  private snapshotTurn: number = 0;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /** 标记快照过期，下次 build 会重新生成 */
  invalidateSnapshot(): void {
    this.snapshot = null;
  }

  /**
   * 构建注入文本。
   * turnIndex 用于判断是否需要快照刷新：
   * - 同一 turn 内多次调用 → 返回缓存
   * - turnIndex 变化但不脏 → 返回缓存（KV 缓存稳定）
   * - invalidateSnapshot() 被调用 → 重新构建
   */
  build(targetPaths: string[], turnIndex: number, budget?: number): InjectionSnapshot {
    // 快照命中
    if (this.snapshot && this.snapshotTurn === turnIndex) {
      return this.snapshot;
    }

    // 如果快照非空且 turn 变化但非强制刷新 → 保持稳定（直到 compaction 或显式 invalidate）
    if (this.snapshot && this.snapshotTurn !== turnIndex) {
      return this.snapshot;
    }

    const cfg = DEFAULT_INJECTION_CONFIG;
    const tokenBudget = budget ?? cfg.tokenBudget;
    const injected: MemoryEntry[] = [];
    const injectedIds: string[] = [];
    let tokensUsed = 0;

    // Phase 0: 固化记忆（固定预算，不参与排名竞争）
    const tenured = this.store.getTenured();
    const tenuredBudget = Math.min(300, Math.floor(tokenBudget * 0.15));
    for (const m of tenured) {
      const cost = estimateTokens(m.content) + 10;
      if (tokensUsed + cost <= tenuredBudget) {
        injected.push(m);
        injectedIds.push(m.id);
        tokensUsed += cost;
      }
    }

    // Phase 1: 路径关联记忆（记忆宫殿）
    if (targetPaths.length > 0) {
      const pathRelevant = this.store.getRelevantToPaths(targetPaths, 10)
        .filter((m) => !injectedIds.includes(m.id));
      for (const m of pathRelevant) {
        const cost = estimateTokens(m.content) + 10;
        if (tokensUsed + cost <= tokenBudget) {
          injected.push(m);
          injectedIds.push(m.id);
          tokensUsed += cost;
        }
      }
    }

    // Phase 2: 按 potency 补充（从竞争池中挑选）
    const remaining = this.store.getTopN(20).filter((m) => !injectedIds.includes(m.id));
    for (const m of remaining) {
      const cost = estimateTokens(m.content) + 10;
      if (tokensUsed + cost <= tokenBudget) {
        injected.push(m);
        injectedIds.push(m.id);
        tokensUsed += cost;
      }
    }

    // 构建文本
    const lines: string[] = [];
    if (injected.length > 0) {
      lines.push("");
      lines.push("## 🧠 长期记忆上下文");
      for (const m of injected) {
        const tag = m.type === "decision" ? "决策" :
          m.type === "convention" ? "约定" :
          m.type === "pattern" ? "模式" :
          m.type === "preference" ? "偏好" :
          m.type === "fact" ? "事实" :
          m.tenured ? "🔒 固化" : "经验";
        lines.push(`- [${tag}] ${m.content}`);
      }
    }

    const text = lines.join("\n");

    // 注册 potency 提升（延迟写入，由 shutdown 统一持久化）
    this.store.registerInjections(injectedIds);

    this.snapshot = { text, injectedIds, tokensUsed };
    this.snapshotTurn = turnIndex;
    return this.snapshot;
  }

  /** 获取当前快照 */
  getCurrentSnapshot(): InjectionSnapshot | null {
    return this.snapshot;
  }
}
