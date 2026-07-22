/** 记忆条目类型 */
export type MemoryType = "decision" | "convention" | "pattern" | "preference" | "fact" | "lesson";

/** 单条记忆 */
export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  /** 关联的文件路径（记忆宫殿） */
  paths: string[];
  /** 效力分数 0.0~1.0 */
  potency: number;
  createdAt: number;
  /** 上次成功注入时间 */
  lastInjectedAt: number;
  /** 上次完成衰减计算的时间，避免同一时间段重复衰减 */
  lastDecayedAt?: number;
  /** 累计注入次数 */
  accessCount: number;
  source: "auto" | "manual" | "user";
  tags: string[];
  /** 来源会话 id（auto 类型时记录） */
  sourceSession?: string;
  /** 是否已固化（accessCount ≥ 固化阈值后自动晋升，不再参与衰减和排名竞争） */
  tenured?: boolean;
}

/** 持久化存储格式 */
export interface MemoryStoreData {
  version: number;
  updatedAt: number;
  memories: MemoryEntry[];
  /** 旧版累计删除计数，仅为数据兼容保留 */
  prunedCount?: number;
  /** 旧版冲突 UI 写入的已处理内容哈希 */
  resolvedSources?: string[];
}

/** 注入配置 */
export interface InjectionConfig {
  /** systemPrompt 中用于记忆的 token 预算 */
  tokenBudget: number;
  /** 单条记忆最大长度（字符） */
  maxMemoryLength: number;
  /** 注入后 potency 增量 */
  potencyBoost: number;
  /** 每日衰减因子 */
  decayFactor: number;
  /** 归档阈值（potency 低于此值的非固化记忆保留但不注入） */
  archiveThreshold: number;
  /** 低效阈值（potency 低于此值但高于归档线的记忆仍可注入） */
  lowEfficiencyThreshold: number;
  /** 固化阈值（accessCount ≥ 此值后自动晋升为永久记忆） */
  tenureThreshold: number;
}

export const DEFAULT_INJECTION_CONFIG: InjectionConfig = {
  tokenBudget: 2000,
  maxMemoryLength: 500,
  potencyBoost: 0.3,
  decayFactor: 0.95,
  archiveThreshold: 0.1,
  lowEfficiencyThreshold: 0.15,
  tenureThreshold: 50,
};

/** 入库闸门判定级别 */
export type DedupeLevel = "exact" | "high" | "mid" | "none";

/** 提取结果 */
export interface ExtractedFact {
  type: MemoryType;
  content: string;
  paths: string[];
  tags: string[];
}
