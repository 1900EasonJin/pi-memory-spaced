/**
 * pi-memory-spaced 命令处理器
 *
 * 所有 /mem:* 命令。在 PiDeck TUI 中使用交互式 SelectList，
 * 非 TUI 模式自动 fallback 到 ctx.ui.notify()。
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, Spacer } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "./store";
import type { MemoryInjector } from "./injector";
import type { MemoryEntry } from "./types";

const TYPE_ICON: Record<string, string> = {
  decision: "🎯",
  convention: "📐",
  pattern: "🔁",
  preference: "⭐",
  fact: "📌",
  lesson: "💡",
};

const TYPE_LABEL: Record<string, string> = {
  decision: "🎯 决策",
  convention: "📐 约定",
  pattern: "🔁 模式",
  preference: "⭐ 偏好",
  fact: "📌 事实",
  lesson: "💡 经验",
};

function potencyBadge(p: number, tenured?: boolean): string {
  if (tenured) return "🔒";
  if (p >= 0.8) return "🔥";
  if (p >= 0.5) return "⭐";
  return "·";
}

/** 记忆 → SelectItem */
function toSelectItem(m: MemoryEntry): SelectItem {
  const prefix = m.tenured ? "🔒 " : "";
  return {
    value: m.id,
    label: prefix + m.content.slice(0, 60) + (m.content.length > 60 ? "…" : ""),
    description: `${TYPE_ICON[m.type] ?? "📝"} · p:${m.potency.toFixed(2)} · 注入${m.accessCount}次${m.tenured ? " 🔒" : ""}`,
  };
}

/** 记忆详情 → 多行文本，用于 notify 展示 */
function formatMemoryDetail(m: MemoryEntry): string[] {
  return [
    `${m.tenured ? "🔒 " : ""}${TYPE_LABEL[m.type] ?? m.type} (${potencyBadge(m.potency, m.tenured)} p:${m.potency.toFixed(2)})`,
    `内容: ${m.content}`,
    m.paths.length > 0 ? `关联路径: ${m.paths.join(", ")}` : "",
    m.tags.length > 0 ? `标签: ${m.tags.join(", ")}` : "",
    `注入 ${m.accessCount} 次 | 创建: ${new Date(m.createdAt).toLocaleDateString()}${m.tenured ? " | 🔒 已固化" : ""}`,
    `ID: ${m.id}`,
  ].filter(Boolean);
}

/**
 * 共享：在 TUI 中弹出记忆选择列表。
 * 返回选中记忆的 ID，或 null（取消）。
 */
async function pickMemory(
  store: MemoryStore,
  ctx: ExtensionCommandContext,
  memories: MemoryEntry[],
  title: string,
): Promise<string | null> {
  if (memories.length === 0) {
    ctx.ui.notify("📭 没有记忆", "info");
    return null;
  }

  const items: SelectItem[] = memories.map(toSelectItem);

  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Spacer(1));

    const maxVisible = Math.min(items.length, 12);
    const selectList = new SelectList(items, maxVisible, {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ 浏览 · enter 查看详情 · esc 取消"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render(width) { return container.render(width); },
      invalidate() { container.invalidate(); },
      handleInput(data) { selectList.handleInput(data); tui.requestRender(); },
    };
  });

  return result ?? null;
}

/**
 * 共享：在 TUI 中展示一条记忆的详情，附带操作按钮。
 * 返回操作："delete" | "back" | null
 */
async function showMemoryDetail(
  store: MemoryStore,
  ctx: ExtensionCommandContext,
  m: MemoryEntry,
): Promise<"delete" | "back" | null> {
  const lines = formatMemoryDetail(m);

  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("🧠 记忆详情")), 1, 0));
    container.addChild(new Spacer(1));

    for (const line of lines) {
      container.addChild(new Text(line, 1, 0));
    }

    container.addChild(new Spacer(1));

    // 操作菜单
    const actionItems: SelectItem[] = [
      { value: "delete", label: "🗑️ 删除此记忆", description: "不可恢复，请确认" },
      { value: "back", label: "← 返回列表" },
    ];
    const actions = new SelectList(actionItems, 2, {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    actions.onSelect = (item) => done(item.value);
    actions.onCancel = () => done(null);

    container.addChild(actions);
    container.addChild(new Text(theme.fg("dim", "↑↓ 选择操作 · enter 确认 · esc 取消"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render(width) { return container.render(width); },
      invalidate() { container.invalidate(); },
      handleInput(data) { actions.handleInput(data); tui.requestRender(); },
    };
  });

  return (result as "delete" | "back" | null) ?? null;
}

/** 更新 PiDeck 底部 Widget（始终可见的记忆统计） */
export function updateMemoryWidget(ctx: { ui: { setWidget: (id: string, content: string[] | undefined) => void; theme?: { fg: (color: string, text: string) => string } } }, store: MemoryStore): void {
  const active = store.getActive();
  const tenured = store.getTenured();

  if (active.length === 0 && tenured.length === 0) {
    ctx.ui.setWidget("mem-spaced", undefined);
    return;
  }

  if (tenured.length > 0) {
    ctx.ui.setWidget("mem-spaced", [`🧠 ${active.length} 活跃 · 🔒 ${tenured.length} 固化`]);
  } else {
    ctx.ui.setWidget("mem-spaced", [`🧠 ${active.length} 活跃`]);
  }
}

export function registerCommands(pi: any, store: MemoryStore, injector: MemoryInjector): void {

  // ── /mem:status ──
  pi.registerCommand("mem:status", {
    description: "查看记忆系统状态概览",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const all = store.getAll();
      const active = store.getActive();
      const archived = store.getArchived();
      const top5 = store.getTopN(5);
      const snapshot = injector.getCurrentSnapshot();

      if (!ctx.hasUI) {
        // ── 非 TUI fallback ──
        const tenured = store.getTenured();
        const lines: string[] = [];
        lines.push("🧠 记忆系统状态");
        lines.push(`总条目: ${all.length} | 活跃: ${active.length} | 🔒 固化: ${tenured.length} | 已归档: ${archived.length}`);
        lines.push(`当前注入快照: ${snapshot ? `${snapshot.injectedIds.length} 条, ${snapshot.tokensUsed} tokens` : "无"}`);
        lines.push("");
        lines.push("Top-5 高优先级:");
        for (const m of top5) {
          const label = TYPE_LABEL[m.type] ?? m.type;
          lines.push(`  ${potencyBadge(m.potency, m.tenured)} ${label}: ${m.content.slice(0, 60)} (p:${m.potency.toFixed(2)})`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // ── TUI 交互式仪表盘 ──
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const container = new Container();

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("🧠 记忆系统状态")), 1, 0));
        container.addChild(new Spacer(1));

        // 统计行
        const tenured = store.getTenured();
        container.addChild(new Text(`总条目: ${theme.fg("accent", String(all.length))}`, 1, 0));
        container.addChild(new Text(`活跃: ${theme.fg("success", String(active.length))} · 🔒 固化: ${theme.fg("accent", String(tenured.length))} · 已归档: ${theme.fg("dim", String(archived.length))}`, 1, 0));
        container.addChild(new Text(
          `注入快照: ${snapshot ? `${snapshot.injectedIds.length} 条, ${snapshot.tokensUsed} tokens` : "无"}`,
          1, 0,
        ));
        container.addChild(new Spacer(1));

        // Top-5
        container.addChild(new Text(theme.fg("accent", "Top-5 高优先级:")), 1, 0);
        for (const m of top5) {
          const icon = TYPE_ICON[m.type] ?? "📝";
          const badge = potencyBadge(m.potency, m.tenured);
          container.addChild(new Text(
            `  ${badge} ${icon} ${m.content.slice(0, 50)}${m.content.length > 50 ? "…" : ""}  ${theme.fg("dim", `p:${m.potency.toFixed(2)}`)}`,
            1, 0,
          ));
        }

        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "按 esc 关闭"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render(width) { return container.render(width); },
          invalidate() { container.invalidate(); },
          handleInput(data) {
            if (data === "\x1b" || data === "q") done();
          },
        };
      });
    },
  });

  // ── /mem:list ──
  pi.registerCommand("mem:list", {
    description: "列出所有活跃记忆（按效力排序），交互式浏览",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const active = store.getActive().sort((a, b) => b.potency - a.potency);
      if (active.length === 0) {
        ctx.ui.notify("📭 暂无活跃记忆", "info");
        return;
      }

      if (!ctx.hasUI) {
        // ── 非 TUI fallback ──
        const lines: string[] = [`📋 活跃记忆 (${active.length} 条)\n`];
        for (const m of active) {
          const label = TYPE_LABEL[m.type] ?? m.type;
          lines.push(`${label} (p:${m.potency.toFixed(2)})`);
          lines.push(`  ${m.content.slice(0, 100)}`);
          if (m.paths.length > 0) lines.push(`  路径: ${m.paths.join(", ")}`);
          if (m.tags.length > 0) lines.push(`  标签: ${m.tags.join(", ")}`);
          lines.push("");
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // ── TUI 交互式浏览 ──
      await browseMemoryList(store, ctx, active, `📋 活跃记忆 (${active.length} 条)`);
    },
  });

  // ── /mem:search ──
  pi.registerCommand("mem:search", {
    description: "搜索记忆（关键词） — 用法: /mem:search <关键词>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!args?.trim()) {
        ctx.ui.notify("请输入搜索关键词: /mem:search <关键词>", "warning");
        return;
      }

      const results = store.search(args.trim()).sort((a, b) => b.potency - a.potency);
      if (results.length === 0) {
        ctx.ui.notify(`未找到包含 "${args.trim()}" 的记忆`, "info");
        return;
      }

      if (!ctx.hasUI) {
        // ── 非 TUI fallback ──
        const lines: string[] = [`🔍 搜索结果: "${args.trim()}" (${results.length} 条)\n`];
        for (const m of results) {
          const label = TYPE_LABEL[m.type] ?? m.type;
          lines.push(`${label} (p:${m.potency.toFixed(2)}) ${m.content.slice(0, 80)}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // ── TUI 交互式浏览 ──
      await browseMemoryList(store, ctx, results, `🔍 搜索结果: "${args.trim()}" (${results.length} 条)`);
    },
  });

  // ── /mem:forget ──
  pi.registerCommand("mem:forget", {
    description: "删除一条记忆 — 用法: /mem:forget <id>（无 ID 则交互式选择）",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const id = args?.trim();

      if (id) {
        // 直接删除
        const m = store.getById(id);
        if (!m) {
          ctx.ui.notify(`未找到 ID 为 "${id}" 的记忆`, "warning");
          return;
        }

        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm("确认删除?", `确定删除: ${m.content.slice(0, 60)}?`);
          if (!ok) { ctx.ui.notify("已取消", "info"); return; }
        }

        store.remove(id);
        store.save();
        updateMemoryWidget(ctx, store);
        ctx.ui.notify(`已删除: ${m.content.slice(0, 60)}`, "info");
        return;
      }

      // 无 ID → 交互式选择
      if (!ctx.hasUI) {
        ctx.ui.notify("用法: /mem:forget <id>（交互模式仅在 TUI 下可用）", "warning");
        return;
      }

      const active = store.getActive().sort((a, b) => b.potency - a.potency);
      if (active.length === 0) {
        ctx.ui.notify("📭 暂无活跃记忆可删除", "info");
        return;
      }

      const pickedId = await pickMemory(store, ctx, active, "🗑️ 选择要删除的记忆");
      if (!pickedId) { ctx.ui.notify("已取消", "info"); return; }

      const m = store.getById(pickedId);
      if (!m) { ctx.ui.notify("记忆已不存在", "warning"); return; }

      const ok = await ctx.ui.confirm("确认删除?", `确定删除: ${m.content.slice(0, 60)}?`);
      if (!ok) { ctx.ui.notify("已取消", "info"); return; }

      store.remove(pickedId);
      store.save();
      updateMemoryWidget(ctx, store);
      ctx.ui.notify(`已删除: ${m.content.slice(0, 60)}`, "info");
    },
  });

  // ── /mem:add ──
  pi.registerCommand("mem:add", {
    description: "手动添加记忆 — 用法: /mem:add <类型> <内容>（类型: decision/convention/pattern/preference/fact/lesson）",
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

      // 入库闸门：任何级别相似都走增强而非重复入库
      const check = store.dedupeCheck(content);
      if (check.level !== "none") {
        const top = check.matches[0];
        store.update(top.entry.id, { potency: Math.min(1.0, top.entry.potency + 0.1) });
        store.save();
        ctx.ui.notify(
          `⚠️ 已有相似记忆（${(top.similarity * 100).toFixed(0)}%），已强化:\n${top.entry.content.slice(0, 60)}`,
          "info",
        );
        return;
      }

      store.add({ type, content, paths: [], potency: 0.8, source: "manual", tags: [] });
      store.save();
      updateMemoryWidget(ctx, store);

      const label = TYPE_LABEL[type] ?? type;
      ctx.ui.notify(`已添加 ${label}: ${content.slice(0, 60)}`, "info");
    },
  });

}

// ────────────────────────────────────────────
// 交互式浏览（list / search 共用）
// ────────────────────────────────────────────

async function browseMemoryList(
  store: MemoryStore,
  ctx: ExtensionCommandContext,
  memories: MemoryEntry[],
  title: string,
): Promise<void> {
  let currentMemories = memories;

  while (true) {
    const pickedId = await pickMemory(store, ctx, currentMemories, title);
    if (!pickedId) break;

    const m = store.getById(pickedId);
    if (!m) {
      ctx.ui.notify("记忆已不存在", "warning");
      break;
    }

    const action = await showMemoryDetail(store, ctx, m);
    if (action === "delete") {
      const ok = await ctx.ui.confirm("确认删除?", `确定删除此记忆？\n${m.content.slice(0, 60)}`);
      if (ok) {
        store.remove(m.id);
        store.save();
        updateMemoryWidget(ctx, store);
        ctx.ui.notify(`已删除: ${m.content.slice(0, 60)}`, "info");
        // 从当前列表移除
        currentMemories = currentMemories.filter((mm) => mm.id !== m.id);
        if (currentMemories.length === 0) {
          ctx.ui.notify("📭 列表已空", "info");
          break;
        }
      }
    } else if (action === "back" || action === null) {
      continue;
    }
  }
}
