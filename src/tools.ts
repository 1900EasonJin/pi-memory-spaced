import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "./store";

export function registerTools(pi: ExtensionAPI, store: MemoryStore): void {
  // memory_recall — LLM 可用，搜索记忆
  pi.registerTool({
    name: "memory_recall",
    label: "Memory Recall",
    description: "搜索长期记忆中的相关事实、决策、模式和约定。当需要回忆之前的架构决策或项目约定时使用。",
    promptSnippet: "Search long-term memory for relevant facts, decisions, and conventions",
    promptGuidelines: [
      "Use memory_recall when you need to recall architectural decisions, coding conventions, or patterns from previous sessions.",
      "Be specific in your query to get the most relevant results.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词（项目名、技术栈、功能模块等）" }),
      limit: Type.Optional(Type.Integer({ description: "返回结果数量上限", default: 5 })),
    }),
    async execute(_toolCallId: string, params: { query: string; limit?: number }, _signal: any, _onUpdate: any) {
      const results = store.search(params.query).slice(0, params.limit ?? 5);
      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "未找到相关记忆。" }],
        };
      }

      const text = results.map((m, i) => {
        const typeLabel =
          m.type === "decision" ? "🎯 决策" :
          m.type === "convention" ? "📐 约定" :
          m.type === "pattern" ? "🔁 模式" :
          m.type === "preference" ? "⭐ 偏好" :
          m.type === "fact" ? "📌 事实" : "💡 经验";
        return `${i + 1}. ${typeLabel}: ${m.content}` +
          (m.paths.length > 0 ? `\n   关联路径: ${m.paths.join(", ")}` : "");
      }).join("\n\n");

      return {
        content: [{ type: "text" as const, text: `找到 ${results.length} 条相关记忆:\n\n${text}` }],
      };
    },
  });

  // memory_remember — LLM 可手动告诉系统记住某个信息
  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description: "手动告诉系统记住一条重要信息（决策、约定、事实等）。用于你觉得后续会话需要记住的内容。",
    promptSnippet: "Explicitly tell the system to remember an important fact, decision, or convention",
    promptGuidelines: [
      "Use memory_remember when the user explicitly states a preference, makes an architectural decision, or establishes a convention that should persist across sessions.",
      "Do NOT use this for every detail — only for durable, cross-session-worthy information.",
    ],
    parameters: Type.Object({
      type: Type.String({ description: "记忆类型: decision/convention/pattern/preference/fact/lesson" }),
      content: Type.String({ description: "要记住的内容（一句话，不超过200字）" }),
      paths: Type.Optional(Type.Array(Type.String(), { description: "关联的文件路径" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "关键词标签" })),
    }),
    async execute(_toolCallId: string, params: {
      type: string; content: string; paths?: string[]; tags?: string[];
    }, _signal: any, _onUpdate: any) {
      const validTypes = ["decision", "convention", "pattern", "preference", "fact", "lesson"];
      const type = validTypes.includes(params.type) ? params.type : "fact";

      store.add({
        type: type as any,
        content: params.content.slice(0, 500),
        paths: params.paths ?? [],
        potency: 0.8,
        source: "manual",
        tags: params.tags ?? [],
      });
      store.save();

      return {
        content: [{ type: "text" as const, text: `✅ 已记住: ${params.content.slice(0, 100)}` }],
      };
    },
  });
}
