import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "./store";
import type { MemoryInjector } from "./injector";

const TYPE_LABEL: Record<string, string> = {
  decision: "🎯 决策",
  convention: "📐 约定",
  pattern: "🔁 模式",
  preference: "⭐ 偏好",
  fact: "📌 事实",
  lesson: "💡 经验",
};

export function registerCommands(pi: any, store: MemoryStore, injector: MemoryInjector): void {
  // /mem status
  pi.registerCommand("mem:status", {
    description: "查看记忆系统状态",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const all = store.getAll();
      const active = store.getActive();
      const archived = store.getArchived();
      const top5 = store.getTopN(5);
      const conflicts = store.getConflicts();
      const snapshot = injector.getCurrentSnapshot();

      const lines: string[] = [];
      lines.push("🧠 记忆系统状态");
      lines.push(`总条目: ${all.length}`);
      lines.push(`活跃: ${active.length} | 已归档: ${archived.length}`);
      lines.push(`待确认冲突: ${conflicts.length}`);
      lines.push(`当前注入快照: ${snapshot ? `${snapshot.injectedIds.length} 条, ${snapshot.tokensUsed} tokens` : "无"}`);
      lines.push("");
      lines.push("Top-5 高优先级:");
      for (const m of top5) {
        const label = TYPE_LABEL[m.type] ?? m.type;
        lines.push(`  ${label}: ${m.content.slice(0, 60)} (p:${m.potency.toFixed(2)})`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /mem list
  pi.registerCommand("mem:list", {
    description: "列出所有活跃记忆（按效力排序）",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const active = store.getActive().sort((a, b) => b.potency - a.potency);
      if (active.length === 0) {
        ctx.ui.notify("暂无活跃记忆", "info");
        return;
      }

      const lines: string[] = [];
      lines.push(`📋 活跃记忆 (${active.length} 条)`);
      lines.push("");
      for (const m of active) {
        const label = TYPE_LABEL[m.type] ?? m.type;
        lines.push(`${label} (p:${m.potency.toFixed(2)})`);
        lines.push(`  ${m.content.slice(0, 100)}`);
        if (m.paths.length > 0) lines.push(`  路径: ${m.paths.join(", ")}`);
        if (m.tags.length > 0) lines.push(`  标签: ${m.tags.join(", ")}`);
        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /mem search
  pi.registerCommand("mem:search", {
    description: "搜索记忆（关键词） — 用法: /mem:search <关键词>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!args?.trim()) {
        ctx.ui.notify("请输入搜索关键词: /mem:search <关键词>", "warning");
        return;
      }

      const results = store.search(args.trim());
      if (results.length === 0) {
        ctx.ui.notify(`未找到包含 "${args}" 的记忆`, "info");
        return;
      }

      const lines: string[] = [];
      lines.push(`🔍 搜索结果: "${args}" (${results.length} 条)`);
      lines.push("");
      for (const m of results) {
        const label = TYPE_LABEL[m.type] ?? m.type;
        lines.push(`${label} (p:${m.potency.toFixed(2)}) ${m.content.slice(0, 80)}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /mem forget
  pi.registerCommand("mem:forget", {
    description: "删除一条记忆 — 用法: /mem:forget <id>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const id = args?.trim();
      if (!id) {
        ctx.ui.notify("请输入记忆 ID: /mem:forget <id>", "warning");
        return;
      }

      const m = store.getById(id);
      if (!m) {
        ctx.ui.notify(`未找到 ID 为 "${id}" 的记忆`, "warning");
        return;
      }

      store.remove(id);
      store.save();
      ctx.ui.notify(`已删除: ${m.content.slice(0, 60)}`, "info");
    },
  });

  // /mem add
  pi.registerCommand("mem:add", {
    description: "手动添加记忆 — 用法: /mem:add <类型> <内容> （类型: decision/convention/pattern/preference/fact/lesson）",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!args?.trim()) {
        ctx.ui.notify("用法: /mem:add <类型> <内容>", "warning");
        return;
      }

      const parts = args.trim().split(/\s+/);
      const type = parts[0] as any;
      const content = parts.slice(1).join(" ");

      if (!["decision", "convention", "pattern", "preference", "fact", "lesson"].includes(type)) {
        ctx.ui.notify("类型必须为: decision/convention/pattern/preference/fact/lesson", "warning");
        return;
      }

      if (content.length < 5) {
        ctx.ui.notify("内容至少 5 个字符", "warning");
        return;
      }

      store.add({
        type,
        content,
        paths: [],
        potency: 0.8,
        source: "manual",
        tags: [],
      });
      store.save();

      const label = TYPE_LABEL[type] ?? type;
      ctx.ui.notify(`已添加 ${label}: ${content.slice(0, 60)}`, "info");
    },
  });

  // /mem conflicts
  pi.registerCommand("mem:conflicts", {
    description: "查看待确认冲突",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const conflicts = store.getConflicts();
      if (conflicts.length === 0) {
        ctx.ui.notify("暂无待确认冲突", "info");
        return;
      }

      const lines: string[] = [];
      lines.push(`⚠️ 待确认冲突 (${conflicts.length} 条)`);
      lines.push("");
      for (let i = 0; i < conflicts.length; i++) {
        const c = conflicts[i];
        const existing = store.getById(c.existingId);
        lines.push(`#${i + 1} 相似度 ${(c.similarity * 100).toFixed(0)}%`);
        lines.push(`  已有: ${existing?.content.slice(0, 80) ?? "(已删除)"}`);
        lines.push(`  新: ${c.newContent.slice(0, 80)}`);
        lines.push(`  处理: /mem:resolve ${i} （删除冲突标记）`);
        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /mem resolve
  pi.registerCommand("mem:resolve", {
    description: "解决冲突 — 用法: /mem:resolve <冲突序号>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const idx = parseInt(args?.trim() ?? "", 10);
      if (isNaN(idx)) {
        ctx.ui.notify("用法: /mem:resolve <冲突序号>（从 0 开始）", "warning");
        return;
      }

      const conflicts = store.getConflicts();
      if (idx < 0 || idx >= conflicts.length) {
        ctx.ui.notify(`序号 ${idx} 超出范围（共 ${conflicts.length} 条）`, "warning");
        return;
      }

      store.resolveConflict(idx);
      store.save();
      ctx.ui.notify(`已解决冲突 #${idx}`, "info");
    },
  });
}
