import type { MemoryStore } from "./store";
import type { ExtractedFact } from "./types";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

const EXTRACT_PROMPT = `你是一个记忆提取器。分析以下对话，提取需要长期记住的事实、决策、模式、约定、偏好和经验教训。

每一条提取结果必须包含：
1. type: 类型（decision/convention/pattern/preference/fact/lesson）
2. content: 简洁的一句话描述（不超过200字）
3. paths: 关联的文件路径（如果对话中提到了具体文件路径）
4. tags: 关键词标签（3-5个）

只提取真正重要的、跨会话有价值的信息。宁缺毋滥：一轮对话提取 0~3 条是常态。

明确不要提取的：
- 一次性细节：本次任务的进度、中间状态、调试过程、报错与修复过程
- 可从代码/git 历史直接获得的信息：文件改了什么、某函数如何实现
- 对 AI 的临时指令、客套话、仅本轮有效的上下文
- 已在常识范围内或显而易见的事实

值得提取的：用户明确表达的偏好、跨会话有效的架构决策、项目约定、反复出现的工作模式、踩坑教训。
如果没有值得记忆的内容，返回空数组。

请以 JSON 数组格式返回，不要包含其他内容。`;

/** 从 ToolResult 消息中提取文件路径 */
function extractPathsFromMessages(messages: any[]): string[] {
  const paths = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "toolResult" && msg.toolName === "read" && msg.details?.filePath) {
      paths.add(msg.details.filePath);
    }
    if (msg.role === "toolResult" && msg.toolName === "edit" && msg.details?.filePath) {
      paths.add(msg.details.filePath);
    }
    if (msg.role === "toolResult" && msg.toolName === "write" && msg.details?.filePath) {
      paths.add(msg.details.filePath);
    }
    // 尝试从 bash 输出中提取路径模式
    if (msg.role === "toolResult" && msg.toolName === "bash" && typeof msg.content?.[0]?.text === "string") {
      const pathMatches = msg.content[0].text.match(/(?:\/[\w.-]+)+/g);
      if (pathMatches) for (const p of pathMatches) paths.add(p);
    }
  }
  return [...paths];
}

/** 将消息列表序列化为 LLM 可读的文本 */
function serializeMessages(messages: any[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.role === "user" ? "用户" :
      msg.role === "assistant" ? "AI" :
      msg.role === "toolResult" ? `工具(${msg.toolName})` : msg.role;
    const text = typeof msg.content === "string" ? msg.content :
      Array.isArray(msg.content) ? msg.content.map((c: any) => c.text ?? "").join(" ").slice(0, 500) : "";
    if (text.trim()) parts.push(`[${role}]: ${text.slice(0, 500)}`);
  }
  return parts.join("\n\n");
}

/**
 * 自动提取器 — 在 agent_settled 时分析对话，提取记忆，检测冲突
 */
export class MemoryExtractor {
  private store: MemoryStore;
  /** 是否正在运行（防止并发） */
  private running = false;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /**
   * 分析对话并提取记忆。
   * @param messages 本轮所有消息
   * @param modelRegistry Pi 的模型注册表，用于获取 LLM 调用能力
   * @param sessionId 当前会话 ID
   */
  async extract(
    messages: any[],
    modelRegistry: ModelRegistry,
    sessionId: string,
  ): Promise<{ added: number }> {
    if (this.running) return { added: 0 };
    if (messages.length < 2) return { added: 0 }; // 至少 2 条消息就尝试提取

    this.running = true;
    try {
      // 1. 序列化对话（短对话没有跨会话价值，直接跳过提取，控制写入频率）
      const conversationText = serializeMessages(messages);
      if (conversationText.length < 400) return { added: 0 };

      // 2. 获取 LLM 模型
      const model = modelRegistry.find("opencode-go", "deepseek-v4-flash")
        ?? modelRegistry.getAll().find((m) => m.reasoning === false);

      if (!model) return { added: 0 };

      const auth = await modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) return { added: 0 };

      // 3. 调用 LLM 提取（附带已有记忆，让 LLM 在语义层跳过重复——2-gram 抓不住中文改写）
      const existing = this.store.getTopN(40).map((m) => `- ${m.content.slice(0, 80)}`).join("\n");
      const userContent = existing
        ? `【已有记忆，语义相同或只是换说法的都不要提取】\n${existing}\n\n【对话内容】\n${conversationText}`
        : conversationText;
      const facts = await this.callLLM(model, auth, userContent);
      if (facts.length === 0) return { added: 0 };

      // 4. 提取文件路径
      const paths = extractPathsFromMessages(messages);

      // 5. 处理每个提取结果（统一走 store 入库闸门，限量写入防垃圾膨胀）
      const MAX_ADD_PER_SESSION = 3;
      let added = 0;

      for (const fact of facts) {
        if (added >= MAX_ADD_PER_SESSION) break;
        const check = this.store.dedupeCheck(fact.content);

        if (check.level === "exact") {
          // 完全重复 → 跳过，仅被动增强
          this.store.update(check.matches[0].entry.id, {
            potency: Math.min(1.0, check.matches[0].entry.potency + 0.05),
          });
          continue;
        }

        if (check.level === "high") {
          // 十分相似 → 合并：paths/tags 取并集，保留更长内容，增强效力
          const top = check.matches[0];
          const longer = fact.content.length > top.entry.content.length;
          this.store.update(top.entry.id, {
            content: longer ? fact.content.slice(0, 500) : top.entry.content,
            paths: [...new Set([...top.entry.paths, ...paths, ...(fact.paths ?? [])])],
            tags: [...new Set([...top.entry.tags, ...(fact.tags ?? [])])],
            potency: Math.min(1.0, top.entry.potency + 0.05),
          });
          continue;
        }

        // mid（重复率较小）/ none → 作为新记忆加入
        this.store.add({
          type: fact.type,
          content: fact.content.slice(0, 500),
          paths: [...new Set([...paths, ...(fact.paths ?? [])])],
          potency: 0.8,
          source: "auto",
          tags: fact.tags ?? [],
          sourceSession: sessionId,
        });
        added++;
      }

      return { added };
    } finally {
      this.running = false;
    }
  }

  private async callLLM(model: any, auth: any, conversation: string): Promise<ExtractedFact[]> {
    try {
      const response = await fetch(`${auth.baseUrl ?? model.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${auth.apiKey}`,
        },
        body: JSON.stringify({
          model: model.id,
          messages: [
            { role: "system", content: EXTRACT_PROMPT },
            { role: "user", content: conversation },
          ],
          temperature: 0.1,
          max_tokens: 2000,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) return [];

      const data = await response.json() as any;
      const text = data.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) return [];

      // 尝试解析 JSON
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      return parsed.map((f: any) => ({
        type: f.type ?? "fact",
        content: f.content ?? "",
        paths: Array.isArray(f.paths) ? f.paths : [],
        tags: Array.isArray(f.tags) ? f.tags : [],
      })).filter((f: ExtractedFact) => f.content.length > 10);
    } catch {
      return [];
    }
  }
}
