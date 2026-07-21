import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { MemoryEntry, MemoryStoreData, InjectionConfig, DedupeLevel } from "./types.ts";
import { DEFAULT_INJECTION_CONFIG } from "./types.ts";

let _idCounter = 0;
function genId(): string {
  return `mem_${Date.now().toString(36)}_${(++_idCounter).toString(36)}`;
}

/** 简单 hash：取字符编码和 */
export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

/** 归一化文本：小写、去除空白与标点符号，用于精确匹配与 hash */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 字符 2-gram 集合（基于归一化文本，中文按字切、英文按字符切，无需分词） */
function bigrams(s: string): Set<string> {
  const t = normalizeText(s);
  const set = new Set<string>();
  if (t.length === 0) return set;
  if (t.length === 1) { set.add(t); return set; }
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** 入库闸门阈值（overlap 系数实测：重复对 0.52~0.66，相关但不同 0.35~0.38，无关 <0.1） */
export const GATE_HIGH_THRESHOLD = 0.8;
export const GATE_MID_THRESHOLD = 0.45;
/** 存量自动合并的阈值，与入库闸门 high 对齐：≥0.8 十分相似才合并，0.45~0.8 允许并存 */
export const DEDUPE_MERGE_THRESHOLD = GATE_HIGH_THRESHOLD;

/**
 * Memory Store — 纯文件系统持久化，间隔重复驱动
 *
 * 存储路径：~/.pi/agent/memory-store.json
 */
export class MemoryStore {
  private data: MemoryStoreData;
  private config: InjectionConfig;
  private storePath: string;
  private dirPath: string;

  constructor(opts?: { storePath?: string; config?: Partial<InjectionConfig> }) {
    this.config = { ...DEFAULT_INJECTION_CONFIG, ...opts?.config };
    this.storePath = opts?.storePath ?? join(homedir(), ".pi", "agent", "memory-store.json");
    this.dirPath = dirname(this.storePath);
    this.data = this.load();
  }

  // ─── 持久化 ───

  private load(): MemoryStoreData {
    // ponytail: 旧 JSON 可能残留 conflicts/resolvedSources 字段，运行时忽略即可
    if (!existsSync(this.storePath)) {
      return { version: 1, updatedAt: Date.now(), memories: [], prunedCount: 0 };
    }
    try {
      const raw = readFileSync(this.storePath, "utf-8");
      const data = JSON.parse(raw) as MemoryStoreData;
      if (data.prunedCount === undefined) data.prunedCount = 0; // 兼容旧数据
      return data;
    } catch {
      return { version: 1, updatedAt: Date.now(), memories: [], prunedCount: 0 };
    }
  }

  save(): void {
    this.data.updatedAt = Date.now();
    mkdirSync(this.dirPath, { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  /** 从磁盘重新加载（外部修改后同步内存状态） */
  reload(): void {
    this.data = this.load();
  }

  // ─── 查询 ───

  getAll(): MemoryEntry[] {
    return this.data.memories;
  }

  getById(id: string): MemoryEntry | undefined {
    return this.data.memories.find((m) => m.id === id);
  }

  /** 获取可注入记忆（固化记忆 + 未斩杀竞争记忆，含低效） */
  getInjectable(): MemoryEntry[] {
    return this.data.memories.filter((m) => m.tenured || m.potency >= this.config.archiveThreshold);
  }

  /** 获取活跃记忆（potency ≥ 低效线） */
  getActive(): MemoryEntry[] {
    return this.data.memories.filter((m) => m.tenured || m.potency >= this.config.lowEfficiencyThreshold);
  }

  /** 获取低效记忆（斩杀线 ≤ potency < 低效线，仍可注入） */
  getLowEfficiency(): MemoryEntry[] {
    return this.data.memories.filter((m) => !m.tenured && m.potency >= this.config.archiveThreshold && m.potency < this.config.lowEfficiencyThreshold);
  }

  /** 获取已固化记忆 */
  getTenured(): MemoryEntry[] {
    return this.data.memories.filter((m) => m.tenured);
  }

  /** 获取累计斩杀的低效记忆条数 */
  getPrunedCount(): number {
    return this.data.prunedCount ?? 0;
  }

  /** 按效力排序取 Top-N（从全部可注入记忆中选，含低效） */
  getTopN(n: number): MemoryEntry[] {
    return [...this.getInjectable()]
      .sort((a, b) => b.potency - a.potency)
      .slice(0, n);
  }

  /** 按路径关联度 + 效力排序（从全部可注入记忆中选，含低效） */
  getRelevantToPaths(targetPaths: string[], limit: number): MemoryEntry[] {
    const scored = this.getInjectable().map((m) => {
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

  /** 对所有记忆执行时间衰减（固化记忆跳过），衰减后斩杀低效记忆 */
  applyDecay(): void {
    const now = Date.now();
    for (const m of this.data.memories) {
      if (m.tenured) continue;
      const daysSince = (now - m.lastInjectedAt) / (86_400_000);
      m.potency *= Math.pow(this.config.decayFactor, daysSince);
      m.potency = Math.max(0, Math.min(1.0, m.potency));
    }
    this.pruneLowPotency();
  }

  /** 斩杀：删除所有 potency 低于阈值的非固化记忆，返回本次删了多少 */
  pruneLowPotency(): { deleted: number } {
    const before = this.data.memories.length;
    this.data.memories = this.data.memories.filter((m) => m.tenured || m.potency >= this.config.archiveThreshold);
    const deleted = before - this.data.memories.length;
    if (deleted > 0) this.data.prunedCount = (this.data.prunedCount ?? 0) + deleted;
    return { deleted };
  }

  /** 标记一条记忆被注入（提升 potency，达到阈值后自动固化） */
  registerInjection(id: string): void {
    const m = this.getById(id);
    if (!m) return;
    m.potency = Math.min(1.0, m.potency + this.config.potencyBoost);
    m.lastInjectedAt = Date.now();
    m.accessCount++;
    if (!m.tenured && m.accessCount >= this.config.tenureThreshold) {
      m.tenured = true;
    }
  }

  /** 批量标记注入 */
  registerInjections(ids: string[]): void {
    for (const id of ids) this.registerInjection(id);
  }

  // ─── 增删改 ───

  add(entry: Omit<MemoryEntry, "id" | "createdAt" | "lastInjectedAt" | "accessCount">): MemoryEntry {
    const now = Date.now();
    const mem: MemoryEntry = {
      ...entry,
      id: genId(),
      potency: entry.potency ?? 0.8,
      createdAt: now,
      lastInjectedAt: now,  // 初始化为创建时间，避免衰减从 1970 开始
      accessCount: 0,
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

  // ─── 相似度（字符 2-gram overlap 系数，中英文通吃）───

  /** 计算两条记忆的文本相似度 0~1（overlap/min(|A|,|B|)，对「同一事实、详略不同」鲁棒） */
  similarity(a: string, b: string): number {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (na.length === 0 || nb.length === 0) return 0;
    if (na === nb) return 1;
    // 包含关系：较短串长度 >=6 且被另一条完整包含 → 视为重复
    if (Math.min(na.length, nb.length) >= 6 && (na.includes(nb) || nb.includes(na))) return 1;
    const sa = bigrams(a);
    const sb = bigrams(b);
    let overlap = 0;
    for (const g of sa) if (sb.has(g)) overlap++;
    return overlap / Math.min(sa.size, sb.size);
  }

  /**
   * 统一入库闸门：检查新内容与全部记忆的重复程度。
   * exact — 归一化后完全相同；high — 相似度 ≥0.8；mid — 相似度 ≥0.45；none — 无重复。
   */
  dedupeCheck(content: string): { level: DedupeLevel; matches: Array<{ entry: MemoryEntry; similarity: number }> } {
    const norm = normalizeText(content);
    const matches = this.getAll()
      .map((m) => ({ entry: m, similarity: this.similarity(content, m.content), exact: normalizeText(m.content) === norm }))
      .filter((s) => s.exact || s.similarity >= GATE_MID_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity);

    const exacts = matches.filter((m) => m.exact);
    if (exacts.length > 0) {
      return { level: "exact", matches: exacts.map(({ entry, similarity }) => ({ entry, similarity })) };
    }
    if (matches.length === 0) return { level: "none", matches: [] };
    const level: DedupeLevel = matches[0].similarity >= GATE_HIGH_THRESHOLD ? "high" : "mid";
    return { level, matches: matches.map(({ entry, similarity }) => ({ entry, similarity })) };
  }

  /**
   * 存量去重：合并归一化精确重复（保留 potency 高者，paths/tags 取并集、accessCount 累加），
   * 中高相似对（≥0.55）自动合并低 potency 到高 potency。不再创建冲突。
   */
  dedupeAll(): { merged: number } {
    let merged = 0;
    // ponytail: O(n²) 扫描，n 为记忆条数（百级以内）；量级变大再换索引
    const sorted = [...this.data.memories].sort((a, b) => b.potency - a.potency);
    const seen = new Map<string, MemoryEntry>();
    const removeIds = new Set<string>();

    for (const m of sorted) {
      const norm = normalizeText(m.content);
      const keeper = seen.get(norm);
      if (keeper) {
        keeper.paths = [...new Set([...keeper.paths, ...m.paths])];
        keeper.tags = [...new Set([...keeper.tags, ...m.tags])];
        keeper.accessCount += m.accessCount;
        removeIds.add(m.id);
        merged++;
      } else {
        seen.set(norm, m);
      }
    }
    if (removeIds.size > 0) {
      this.data.memories = this.data.memories.filter((m) => !removeIds.has(m.id));
    }

    // 十分相似（≥0.8，同一事实的措辞变体）→ 自动合并低 potency 到高 potency
    // ponytail: 阈值与入库闸门 high 一致，mid 区间（0.45~0.8）作为独立记忆保留
    const sorted2 = [...this.data.memories].sort((a, b) => b.potency - a.potency);
    const removeIds2 = new Set<string>();
    for (let i = 0; i < sorted2.length; i++) {
      if (removeIds2.has(sorted2[i].id)) continue;
      for (let j = i + 1; j < sorted2.length; j++) {
        if (removeIds2.has(sorted2[j].id)) continue;
        if (this.similarity(sorted2[i].content, sorted2[j].content) >= DEDUPE_MERGE_THRESHOLD) {
          sorted2[i].paths = [...new Set([...sorted2[i].paths, ...sorted2[j].paths])];
          sorted2[i].tags = [...new Set([...sorted2[i].tags, ...sorted2[j].tags])];
          sorted2[i].accessCount += sorted2[j].accessCount;
          removeIds2.add(sorted2[j].id);
          merged++;
        }
      }
    }
    if (removeIds2.size > 0) {
      this.data.memories = this.data.memories.filter((m) => !removeIds2.has(m.id));
    }

    return { merged };
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
