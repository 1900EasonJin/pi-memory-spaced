/**
 * pi-memory-spaced — 间隔重复驱动的 Pi Agent 记忆系统
 *
 * 特性：
 * - 自动提取 + 冲突检测 + 即时确认
 * - 间隔重复：效力分数随时间衰减，注入时增强
 * - 记忆宫殿：按文件路径关联检索记忆
 * - KV 缓存稳定：同一 session 内注入内容保持稳定
 * - 口语指令："记住：xxx" 直接拦截存储
 *
 * 安装：pi -e ./src/index.ts 或放入 ~/.pi/agent/extensions/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "./store.ts";
import { MemoryInjector } from "./injector.ts";
import { MemoryExtractor } from "./extractor.ts";
import { writeIndexMd } from "./index-md.ts";
import { extractPathsFromToolCalls, collectSessionPaths } from "./path-assoc.ts";
import { registerCommands } from "./commands.ts";
import { registerTools } from "./tools.ts";
import { join } from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
  const storeDir = join(homedir(), ".pi", "agent");
  const store = new MemoryStore({ storePath: join(storeDir, "memory-store.json") });
  const injector = new MemoryInjector(store);
  const extractor = new MemoryExtractor(store);
  let turnCounter = 0;
  let sessionId = "";

  // ─── session_start: 加载状态，执行衰减 ───
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionId = ctx.sessionManager?.getSessionId() ?? "unknown";
    store.applyDecay();
    store.save();

    const data = { version: 1, updatedAt: Date.now(), memories: store.getAll(), conflicts: store.getConflicts() };
    writeIndexMd(storeDir, data);

    injector.invalidateSnapshot();
    ctx.ui.setStatus("mem-spaced", `${store.getActive().length} 条记忆`);
  });

  // ─── input: 拦截"记住：xxx"口语指令 ───
  pi.on("input", async (event: any, ctx: any) => {
    const text = event.text?.trim();
    if (!text) return;

    // 匹配模式：记住：xxx / 记住: xxx / 请记住 xxx / 记一下 xxx
    const match = text.match(/^(?:记住|记一下|请记住)\s*[：:]\s*(.+)/);
    const simpleMatch = text.match(/^记住\s+(.+)/);
    const cmdMatch = text.startsWith("/记住") ? text.replace("/记住", "").trim() : null;

    const content = match?.[1] ?? simpleMatch?.[1] ?? cmdMatch;
    if (!content || content.length < 3) return;

    // 直接存入记忆
    store.add({
      type: "preference",
      content: content.slice(0, 500),
      paths: [],
      potency: 0.9,  // 用户主动说的，高权重
      source: "user",
      tags: [],
      sourceSession: sessionId,
    });
    store.save();

    const data = { version: 1, updatedAt: Date.now(), memories: store.getAll(), conflicts: store.getConflicts() };
    writeIndexMd(storeDir, data);
    ctx.ui.setStatus("mem-spaced", `${store.getActive().length} 条记忆`);
    ctx.ui.notify(`✅ 已记住: ${content.slice(0, 80)}`, "info");

    return { action: "handled" as const };
  });

  // ─── before_agent_start: 注入记忆到上下文 ───
  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    const targetPaths: string[] = [];
    if (event.prompt) {
      const pathMatches = event.prompt.match(/(?:\/[\w.-]+)+/g);
      if (pathMatches) targetPaths.push(...pathMatches);
    }

    const snapshot = injector.build(targetPaths, turnCounter);
    if (snapshot.text) {
      return { systemPrompt: event.systemPrompt + snapshot.text };
    }
  });

  // ─── turn_end: 轮次计数 ───
  pi.on("turn_end", async () => { turnCounter++; });

  // ─── tool_call: 收集路径 ───
  pi.on("tool_call", async (event: any, _ctx: any) => {
    extractPathsFromToolCalls([{ name: event.toolName, args: event.input }]);
  });

  // ─── session_before_compact: 刷新快照 ───
  pi.on("session_before_compact", async () => { injector.invalidateSnapshot(); });

  // ─── agent_settled: 对话结束，自动提取 + 冲突确认 ───
  pi.on("agent_settled", async (_event: any, ctx: any) => {
    try {
      const entries = ctx.sessionManager?.getBranch?.() ?? [];
      const messages = entries
        .filter((e: any) => e.type === "message")
        .map((e: any) => e.message)
        .filter(Boolean);

      // 降低阈值：至少 2 条消息就尝试提取
      if (messages.length < 2) return;

      const result = await extractor.extract(messages, ctx.modelRegistry, sessionId);
      if (result.added === 0 && result.conflicts === 0) return;

      store.save();
      const data = { version: 1, updatedAt: Date.now(), memories: store.getAll(), conflicts: store.getConflicts() };
      writeIndexMd(storeDir, data);
      ctx.ui.setStatus("mem-spaced", `${store.getActive().length} 条记忆`);

      if (result.added > 0) {
        ctx.ui.notify(`🧠 自动记忆: 新增 ${result.added} 条`, "info");
      }

      // 冲突即时确认（只在有 UI 时弹出）
      if (result.conflicts > 0 && ctx.hasUI) {
        const conflicts = store.getConflicts();
        const latest = conflicts[conflicts.length - 1];
        if (latest) {
          const existing = store.getById(latest.existingId);
          const msg =
            `检测到潜在冲突:\n` +
            `已有: ${existing?.content.slice(0, 80)}\n` +
            `新: ${latest.newContent.slice(0, 80)}\n\n` +
            `保留旧记忆还是接受新内容？`;

          const choice = await ctx.ui.select(msg, [
            { label: "保留旧记忆（忽略新内容）", value: "keep" },
            { label: "接受新内容（替换旧记忆）", value: "replace" },
            { label: "稍后决定（标记待确认）", value: "later" },
          ]);

          if (choice === "replace" && existing) {
            store.remove(existing.id);
            store.add({
              type: existing.type,
              content: latest.newContent,
              paths: existing.paths,
              potency: existing.potency + 0.1,
              source: "auto",
              tags: existing.tags,
            });
            store.resolveConflict(conflicts.length - 1);
            store.save();
            ctx.ui.notify("✅ 已更新记忆", "info");
          } else if (choice === "keep") {
            store.resolveConflict(conflicts.length - 1);
            store.save();
            ctx.ui.notify("已保留旧记忆", "info");
          } else {
            ctx.ui.notify(`⚠️ ${result.conflicts} 条冲突待确认，/mem:conflicts 查看`, "warning");
          }

          // 更新 MEMORY.md
          const d2 = { version: 1, updatedAt: Date.now(), memories: store.getAll(), conflicts: store.getConflicts() };
          writeIndexMd(storeDir, d2);
          ctx.ui.setStatus("mem-spaced", `${store.getActive().length} 条记忆`);
        }
      } else if (result.conflicts > 0) {
        ctx.ui.notify(`⚠️ 发现 ${result.conflicts} 条潜在冲突，/mem:conflicts 查看`, "warning");
      }
    } catch { /* 静默失败 */ }
  });

  // ─── session_shutdown: 持久化 ───
  pi.on("session_shutdown", async () => {
    store.save();
    const data = { version: 1, updatedAt: Date.now(), memories: store.getAll(), conflicts: store.getConflicts() };
    writeIndexMd(storeDir, data);
  });

  // ─── 注册命令和工具 ───
  registerCommands(pi as any, store, injector);
  registerTools(pi, store);
}
