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
  /** 累计注入次数 */
  accessCount: number;
  source: "auto" | "manual" | "user";
  tags: string[];
  /** 来源会话 id（auto 类型时记录） */
  sourceSession?: string;
}

/** 持久化存储格式 */
export interface MemoryStoreData {
  version: number;
  updatedAt: number;
  memories: MemoryEntry[];
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
  /** 存档阈值 */
  archiveThreshold: number;
}

export const DEFAULT_INJECTION_CONFIG: InjectionConfig = {
  tokenBudget: 2000,
  maxMemoryLength: 500,
  potencyBoost: 0.3,
  decayFactor: 0.95,
  archiveThreshold: 0.1,
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
