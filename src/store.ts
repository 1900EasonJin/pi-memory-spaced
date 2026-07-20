import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { MemoryEntry, MemoryStoreData, InjectionConfig, ConflictItem } from "./types.ts";
import { DEFAULT_INJECTION_CONFIG } from "./types.ts";

let _idCounter = 0;
function genId(): string {
  return `mem_${Date.now().toString(36)}_${(++_idCounter).toString(36)}`;
}

/**
 * Memory Store — 纯文件系统持久化，间隔重复驱动
 *
 * 存储路径：~/.pi/agent/memory-spaced/memory-store.json
 */
export class MemoryStore {
  private data: MemoryStoreData;
  private config: InjectionConfig;
  private storePath: string;
  private dirPath: string;

  constructor(opts?: { storePath?: string; config?: Partial<InjectionConfig> }) {
    this.config = { ...DEFAULT_INJECTION_CONFIG, ...opts?.config };
    this.storePath = opts?.storePath ?? join(homedir(), ".pi", "agent", "memory-spaced", "memory-store.json");
    this.dirPath = dirname(this.storePath);
    this.data = this.load();
  }

  // ─── 持久化 ───

  private load(): MemoryStoreData {
    if (!existsSync(this.storePath)) {
      return { version: 1, updatedAt: Date.now(), memories: [], conflicts: [] };
    }
    try {
      const raw = readFileSync(this.storePath, "utf-8");
      return JSON.parse(raw) as MemoryStoreData;
    } catch {
      return { version: 1, updatedAt: Date.now(), memories: [], conflicts: [] };
    }
  }

  save(): void {
    this.data.updatedAt = Date.now();
    mkdirSync(this.dirPath, { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  // ─── 查询 ───

  getAll(): MemoryEntry[] {
    return this.data.memories;
  }

  getById(id: string): MemoryEntry | undefined {
    return this.data.memories.find((m) => m.id === id);
  }

  getConflicts(): ConflictItem[] {
    return this.data.conflicts;
  }

  /** 获取活跃记忆（未归档的） */
  getActive(): MemoryEntry[] {
    return this.data.memories.filter((m) => m.potency >= this.config.archiveThreshold);
  }

  /** 获取已归档记忆 */
  getArchived(): MemoryEntry[] {
    return this.data.memories.filter((m) => m.potency < this.config.archiveThreshold);
  }

  /** 按效力排序取 Top-N */
  getTopN(n: number): MemoryEntry[] {
    return [...this.getActive()]
      .sort((a, b) => b.potency - a.potency)
      .slice(0, n);
  }

  /** 按路径关联度 + 效力排序 */
  getRelevantToPaths(targetPaths: string[], limit: number): MemoryEntry[] {
    const scored = this.getActive().map((m) => {
      let pathScore = 0;
      for (const tp of targetPaths) {
        for (const mp of m.paths) {
          if (tp === mp) pathScore += 1.0;
          else if (tp.startsWith(mp) || mp.startsWith(tp)) pathScore += 0.5;
        }
      }
      return { entry: m, score: m.potency * 0.6 + Math.min(pathScore, 1.0) * 0.4 };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  /** 关键词搜索 */
  search(query: string): MemoryEntry[] {
    const q = query.toLowerCase();
    return this.data.memories.filter((m) => {
      if (m.content.toLowerCase().includes(q)) return true;
      if (m.tags.some((t) => t.toLowerCase().includes(q))) return true;
      return false;
    });
  }

  // ─── 间隔重复算法 ───

  /** 对所有记忆执行时间衰减 */
  applyDecay(): void {
    const now = Date.now();
    for (const m of this.data.memories) {
      const daysSince = (now - m.lastInjectedAt) / (86_400_000);
      m.potency *= Math.pow(this.config.decayFactor, daysSince);
      m.potency = Math.max(0, Math.min(1.0, m.potency));
    }
  }

  /** 标记一条记忆被注入（提升 potency） */
  registerInjection(id: string): void {
    const m = this.getById(id);
    if (!m) return;
    m.potency = Math.min(1.0, m.potency + this.config.potencyBoost);
    m.lastInjectedAt = Date.now();
    m.accessCount++;
  }

  /** 批量标记注入 */
  registerInjections(ids: string[]): void {
    for (const id of ids) this.registerInjection(id);
  }

  // ─── 增删改 ───

  add(entry: Omit<MemoryEntry, "id" | "createdAt" | "lastInjectedAt" | "accessCount" | "conflictsWith">): MemoryEntry {
    const now = Date.now();
    const mem: MemoryEntry = {
      ...entry,
      id: genId(),
      potency: entry.potency ?? 0.8,
      createdAt: now,
      lastInjectedAt: now,  // 初始化为创建时间，避免衰减从 1970 开始
      accessCount: 0,
      conflictsWith: [],
    };
    this.data.memories.push(mem);
    return mem;
  }

  remove(id: string): boolean {
    const idx = this.data.memories.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.data.memories.splice(idx, 1);
    return true;
  }

  update(id: string, patch: Partial<MemoryEntry>): boolean {
    const m = this.getById(id);
    if (!m) return false;
    Object.assign(m, patch);
    return true;
  }

  /** 存档 potency 过低的记忆（实际不移除，只是标记） */
  archiveLowPotency(): number {
    let count = 0;
    for (const m of this.data.memories) {
      if (m.potency < this.config.archiveThreshold && m.potency >= 0) {
        // 将 potency 设为负值表示已归档（区别于活跃的低分条目）
        // 我们用 0 到 threshold 之间表示"低但活跃"
        // 归档就是不再出现在 getActive() 中
        count++;
      }
    }
    return count;
  }

  // ─── 冲突管理 ───

  addConflict(item: ConflictItem): void {
    this.data.conflicts.push(item);
  }

  resolveConflict(index: number): void {
    if (index >= 0 && index < this.data.conflicts.length) {
      this.data.conflicts.splice(index, 1);
    }
  }

  // ─── 相似度（简单关键词重叠）───

  /** 计算两条记忆的文本相似度 0~1 */
  similarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
    const wordsB = b.toLowerCase().split(/\W+/).filter(Boolean);
    if (wordsA.size === 0 || wordsB.length === 0) return 0;
    let overlap = 0;
    for (const w of wordsB) if (wordsA.has(w)) overlap++;
    return overlap / Math.max(wordsA.size, wordsB.length);
  }

  /** 找出一条新内容与已有记忆的冲突（相似度在冲突区间内） */
  findConflicts(content: string, threshold = 0.6): Array<{ entry: MemoryEntry; similarity: number }> {
    return this.getActive()
      .map((m) => ({ entry: m, similarity: this.similarity(content, m.content) }))
      .filter((s) => s.similarity >= threshold);
  }
}

export function createStore(): MemoryStore {
  return new MemoryStore();
}
