/** 记忆条目类型 */
export type MemoryType = "decision" | "convention" | "pattern" | "preference" | "fact" | "lesson";

/**
 * 候选记忆类别（提取阶段判定，决定是否允许入库）：
 * - preference  领导/用户明确表达的偏好 → 必须 durable 才入库
 * - workflow    反复出现的工作方式/流程 → 必须 durable 才入库
 * - constraint  跨会话稳定的约束/约定 → 必须 durable 才入库
 * - lesson      踩坑教训（反复验证过的）→ 必须 durable 才入库
 * - decision    跨会话有效的架构决策 → 必须 durable 才入库
 * - project_fact 一次性项目细节（路径/分支/构建结果/进度）→ 一律拒绝
 */
export type MemoryKind = "preference" | "workflow" | "constraint" | "lesson" | "decision" | "project_fact";

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
  /** 独立证据出现次数（重复表达强化计数，旧数据缺省视为 1） */
  evidenceCount?: number;
  /** 被 memory_recall 检索命中的次数（闭环反馈信号：复习成功计数） */
  recallHitCount?: number;
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
  /** 每日新增计数（配额控制，自动路径用） */
  dailyAddedDate?: string;
  dailyAddedCount?: number;
  /** 自寻最优统计（旧数据缺省时初始化） */
  adaptation?: AdaptationStats;
}

/** 自寻最优统计窗口（闭环反馈的测量数据） */
export interface AdaptationStats {
  /** 当前统计窗口起点 */
  windowStart: number;
  /** 窗口内注入次数 */
  injections: number;
  /** 窗口内检索命中次数 */
  recallHits: number;
  /** 上次自适应评估时间 */
  lastAdaptedAt: number;
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
  /** 闭环反馈：memory_recall 命中一次的记忆强化增量（复习成功） */
  recallBoost: number;
}

export const DEFAULT_INJECTION_CONFIG: InjectionConfig = {
  tokenBudget: 2000,
  maxMemoryLength: 500,
  potencyBoost: 0.3,
  decayFactor: 0.95,
  archiveThreshold: 0.2,
  lowEfficiencyThreshold: 0.3,
  tenureThreshold: 50,
  recallBoost: 0.03,
};

/** 入库闸门判定级别 */
export type DedupeLevel = "exact" | "high" | "mid" | "none";

/** 提取结果（LLM 原始输出经 normalizeFact 校验后） */
export interface ExtractedFact {
  type: MemoryType;
  content: string;
  paths: string[];
  tags: string[];
  kind: MemoryKind;
  /** 硬闸门：非 true 的候选在解析阶段直接丢弃 */
  durable: boolean;
}
