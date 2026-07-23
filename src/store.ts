import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { MemoryEntry, MemoryStoreData, InjectionConfig, DedupeLevel } from "./types.ts";
import { DEFAULT_INJECTION_CONFIG } from "./types.ts";

function genId(): string {
  return `mem_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

const VALID_TYPES = new Set(["decision", "convention", "pattern", "preference", "fact", "lesson"]);
const VALID_SOURCES = new Set(["auto", "manual", "user"]);
const SOURCE_PRIORITY = { auto: 0, manual: 1, user: 2 } as const;
const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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
  private lockPath: string;
  private diskHash = "";
  private revision = 0;

  constructor(opts?: { storePath?: string; config?: Partial<InjectionConfig> }) {
    this.config = { ...DEFAULT_INJECTION_CONFIG, ...opts?.config };
    this.storePath = opts?.storePath ?? join(homedir(), ".pi", "agent", "memory-store.json");
    this.dirPath = dirname(this.storePath);
    this.lockPath = `${this.storePath}.lock`;
    const loaded = this.load();
    this.data = loaded.data;
    this.diskHash = loaded.hash;
  }

  // ─── 持久化 ───

  private emptyData(): MemoryStoreData {
    return { version: 1, updatedAt: Date.now(), memories: [], prunedCount: 0, resolvedSources: [] };
  }

  private load(): { data: MemoryStoreData; hash: string } {
    if (!existsSync(this.storePath)) return { data: this.emptyData(), hash: "" };

    const raw = readFileSync(this.storePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`记忆库 JSON 损坏: ${this.storePath}`, { cause: error });
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as MemoryStoreData).memories)) {
      throw new Error(`记忆库格式无效: ${this.storePath}`);
    }

    const now = Date.now();
    const source = parsed as MemoryStoreData;
    const memories = source.memories
      .filter((m) => m && typeof m === "object" && typeof m.content === "string")
      .map((m) => {
        const createdAt = Number.isFinite(m.createdAt) ? m.createdAt : now;
        const lastInjectedAt = Number.isFinite(m.lastInjectedAt) ? m.lastInjectedAt : createdAt;
        return {
          ...m,
          id: typeof m.id === "string" && m.id ? m.id : genId(),
          type: VALID_TYPES.has(m.type) ? m.type : "fact",
          content: m.content.slice(0, this.config.maxMemoryLength),
          paths: Array.isArray(m.paths) ? m.paths.filter((p): p is string => typeof p === "string") : [],
          potency: Number.isFinite(m.potency) ? Math.max(0, Math.min(1, m.potency)) : 0.8,
          createdAt,
          lastInjectedAt,
          lastDecayedAt: Number.isFinite(m.lastDecayedAt) ? m.lastDecayedAt : lastInjectedAt,
          accessCount: Number.isFinite(m.accessCount) ? Math.max(0, Math.floor(m.accessCount)) : 0,
          source: VALID_SOURCES.has(m.source) ? m.source : "auto",
          tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === "string") : [],
          tenured: m.tenured === true || undefined,
        } as MemoryEntry;
      });

    return {
      data: {
        ...source,
        version: 1,
        updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : now,
        memories,
        prunedCount: Number.isFinite(source.prunedCount) ? source.prunedCount : 0,
        resolvedSources: Array.isArray(source.resolvedSources)
          ? source.resolvedSources.filter((hash): hash is string => typeof hash === "string")
          : [],
      },
      hash: contentHash(raw),
    };
  }

  private saveAtomic(): void {
    this.data.updatedAt = Date.now();
    mkdirSync(this.dirPath, { recursive: true });
    const serialized = JSON.stringify(this.data, null, 2);
    const tempPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, serialized, { encoding: "utf-8", mode: 0o600 });
      renameSync(tempPath, this.storePath);
      this.diskHash = contentHash(serialized);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  private acquireLock(): () => void {
    mkdirSync(this.dirPath, { recursive: true });
    const deadline = Date.now() + 2_000;
    let fd: number | undefined;

    while (fd === undefined) {
      try {
        fd = openSync(this.lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > 10_000) unlinkSync(this.lockPath);
        } catch { /* 竞争方可能已释放锁 */ }
        if (Date.now() >= deadline) throw new Error(`记忆库写锁超时: ${this.lockPath}`);
        Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 10);
      }
    }

    return () => {
      closeSync(fd);
      try { unlinkSync(this.lockPath); } catch { /* 已被清理 */ }
    };
  }

  save(): void {
    this.saveAtomic();
  }

  /** 从磁盘重新加载；内容发生变化时递增 revision。 */
  reload(): boolean {
    const loaded = this.load();
    const changed = loaded.hash !== this.diskHash;
    this.data = loaded.data;
    this.diskHash = loaded.hash;
    if (changed) this.revision++;
    return changed;
  }

  reloadIfChanged(): boolean {
    const hash = existsSync(this.storePath) ? contentHash(readFileSync(this.storePath, "utf-8")) : "";
    return hash !== this.diskHash ? this.reload() : false;
  }

  getRevision(): number {
    return this.revision;
  }

  getConfig(): Readonly<InjectionConfig> {
    return this.config;
  }

  getStorePath(): string {
    return this.storePath;
  }

  /**
   * 基于磁盘最新版本执行一次原子读改写。扩展中的所有生产写入都走此入口。
   * ponytail: 单文件全局锁足够当前低频写入；写入量显著增长时再拆分存储。
   */
  mutate<T>(mutator: () => T): T {
    const release = this.acquireLock();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        this.reload();
        const baseHash = this.diskHash;
        const result = mutator();
        const currentHash = existsSync(this.storePath)
          ? contentHash(readFileSync(this.storePath, "utf-8"))
          : "";
        if (currentHash !== baseHash) continue;
        this.saveAtomic();
        return result;
      }
      throw new Error("记忆库在写入期间持续变化，请稍后重试");
    } finally {
      release();
    }
  }

  private markChanged(): void {
    this.revision++;
  }

  // ─── 查询 ───

  getAll(): MemoryEntry[] {
    return this.data.memories;
  }

  getById(id: string): MemoryEntry | undefined {
    return this.data.memories.find((m) => m.id === id);
  }

  /** 获取可注入记忆（固化记忆 + 未归档记忆，含低效） */
  getInjectable(): MemoryEntry[] {
    return this.data.memories.filter((m) => m.tenured || m.potency >= this.config.archiveThreshold);
  }

  /** 获取活跃记忆（potency ≥ 低效线） */
  getActive(): MemoryEntry[] {
    return this.data.memories.filter((m) => m.tenured || m.potency >= this.config.lowEfficiencyThreshold);
  }

  /** 获取低效记忆（归档线 ≤ potency < 低效线，仍可注入） */
  getLowEfficiency(): MemoryEntry[] {
    return this.data.memories.filter((m) => !m.tenured && m.potency >= this.config.archiveThreshold && m.potency < this.config.lowEfficiencyThreshold);
  }

  /** 获取已归档记忆（保留在 Store，但不参与自动注入） */
  getArchived(): MemoryEntry[] {
    return this.data.memories.filter((m) => !m.tenured && m.potency < this.config.archiveThreshold);
  }

  /** 获取已固化记忆 */
  getTenured(): MemoryEntry[] {
    return this.data.memories.filter((m) => m.tenured);
  }

  /** 按效力排序取 Top-N（从全部可注入记忆中选，含低效） */
  getTopN(n: number): MemoryEntry[] {
    return [...this.getInjectable()]
      .sort((a, b) => b.potency - a.potency)
      .slice(0, n);
  }

  /** 按路径关联度 + 效力排序；没有真实路径命中的记忆不参与本阶段。 */
  getRelevantToPaths(targetPaths: string[], limit: number): MemoryEntry[] {
    const normalizePath = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
    const related = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    const normalizedTargets = targetPaths.map(normalizePath);
    const scored = this.getInjectable().map((m) => {
      let pathScore = 0;
      for (const target of normalizedTargets) {
        for (const memoryPath of m.paths.map(normalizePath)) {
          if (target === memoryPath) pathScore += 1;
          else if (related(target, memoryPath)) pathScore += 0.5;
        }
      }
      return { entry: m, pathScore, score: m.potency * 0.6 + Math.min(pathScore, 1) * 0.4 };
    });
    return scored
      .filter((item) => item.pathScore > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.entry);
  }

  isResolvedContent(content: string): boolean {
    const hashes = this.data.resolvedSources ?? [];
    return hashes.includes(simpleHash(content)) || hashes.includes(simpleHash(normalizeText(content)));
  }

  markResolvedContent(content: string): void {
    const hash = simpleHash(normalizeText(content));
    this.data.resolvedSources ??= [];
    if (!this.data.resolvedSources.includes(hash)) {
      this.data.resolvedSources.push(hash);
      this.markChanged();
    }
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

  /** 对所有记忆执行一次增量衰减；归档记忆保留在 Store 中。 */
  applyDecay(now = Date.now()): void {
    let changed = false;
    for (const m of this.data.memories) {
      if (m.tenured) continue;
      const anchor = m.lastDecayedAt ?? m.lastInjectedAt ?? m.createdAt;
      const daysSince = Math.max(0, (now - anchor) / 86_400_000);
      if (daysSince > 0) {
        m.potency = Math.max(0, Math.min(1, m.potency * Math.pow(this.config.decayFactor, daysSince)));
        changed = true;
      }
      if (m.lastDecayedAt !== now) {
        m.lastDecayedAt = now;
        changed = true;
      }
    }
    if (changed) this.markChanged();
  }

  /** 标记一条记忆被注入（提升 potency，达到阈值后自动固化） */
  registerInjection(id: string): void {
    const m = this.getById(id);
    if (!m) return;
    const now = Date.now();
    m.potency = Math.min(1.0, m.potency + this.config.potencyBoost);
    m.lastInjectedAt = now;
    m.lastDecayedAt = now;
    m.accessCount++;
    if (!m.tenured && m.accessCount >= this.config.tenureThreshold) m.tenured = true;
    this.markChanged();
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
      lastInjectedAt: now,
      lastDecayedAt: now,
      accessCount: 0,
    };
    this.data.memories.push(mem);
    this.markChanged();
    return mem;
  }

  remove(id: string): boolean {
    const idx = this.data.memories.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.data.memories.splice(idx, 1);
    this.markChanged();
    return true;
  }

  update(id: string, patch: Partial<MemoryEntry>): boolean {
    const m = this.getById(id);
    if (!m) return false;
    Object.assign(m, patch);
    this.markChanged();
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

  /** 自动合并归一化后完全相同的条目；相似内容可能是纠正或冲突，不自动删除。 */
  dedupeAll(): { merged: number } {
    let merged = 0;
    const sorted = [...this.data.memories].sort((a, b) => b.potency - a.potency);
    const seen = new Map<string, MemoryEntry>();
    const removeIds = new Set<string>();

    for (const memory of sorted) {
      const normalized = normalizeText(memory.content);
      const keeper = seen.get(normalized);
      if (!keeper) {
        seen.set(normalized, memory);
        continue;
      }

      const preferredSource = SOURCE_PRIORITY[memory.source] > SOURCE_PRIORITY[keeper.source] ? memory : keeper;
      keeper.paths = [...new Set([...keeper.paths, ...memory.paths])];
      keeper.tags = [...new Set([...keeper.tags, ...memory.tags])];
      keeper.potency = Math.max(keeper.potency, memory.potency);
      keeper.createdAt = Math.min(keeper.createdAt, memory.createdAt);
      keeper.lastInjectedAt = Math.max(keeper.lastInjectedAt, memory.lastInjectedAt);
      keeper.lastDecayedAt = Math.max(
        keeper.lastDecayedAt ?? keeper.lastInjectedAt,
        memory.lastDecayedAt ?? memory.lastInjectedAt,
      );
      keeper.accessCount += memory.accessCount;
      keeper.tenured = keeper.tenured || memory.tenured || keeper.accessCount >= this.config.tenureThreshold || undefined;
      keeper.source = preferredSource.source;
      keeper.type = preferredSource.type;
      keeper.sourceSession = preferredSource.sourceSession ?? keeper.sourceSession;
      removeIds.add(memory.id);
      merged++;
    }

    if (removeIds.size > 0) {
      this.data.memories = this.data.memories.filter((memory) => !removeIds.has(memory.id));
      this.markChanged();
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
