/**
 * pi-memory-spaced — 间隔重复驱动的 Pi Agent 记忆系统
 *
 * 特性：
 * - 自动提取 + 自动去重合并（零打扰）
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
import { extractPathsFromToolCalls } from "./path-assoc.ts";
import { registerCommands, updateMemoryWidget } from "./commands.ts";
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
    store.reload(); // 从磁盘重新加载，同步外部修改

    // 存量去重：自动合并精确重复和中高相似记忆（≥0.55），零打扰
    const dd = store.dedupeAll();
    if (dd.merged > 0) {
      ctx.ui.notify(`🧠 已合并 ${dd.merged} 条重复/相似记忆`, "info");
    }

    store.applyDecay();
    store.save();

    const data = { version: 1, updatedAt: Date.now(), memories: store.getAll() };
    writeIndexMd(storeDir, data);

    injector.invalidateSnapshot();
    updateMemoryWidget(ctx, store);
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

    // 入库闸门：任何级别的相似都走增强而非重复入库
    const check = store.dedupeCheck(content);
    if (check.level !== "none") {
      const top = check.matches[0];
      store.update(top.entry.id, { potency: Math.min(1.0, top.entry.potency + 0.1) });
      store.save();
      updateMemoryWidget(ctx, store);
      ctx.ui.notify(`⚠️ 已有相似记忆（${(top.similarity * 100).toFixed(0)}%），已强化而非重复入库:\n${top.entry.content.slice(0, 80)}`, "info");
      return { action: "handled" as const };
    }

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
    updateMemoryWidget(ctx, store);

    const data = { version: 1, updatedAt: Date.now(), memories: store.getAll() };
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

  // ─── agent_settled: 对话结束，自动提取 ───
  // ponytail: 不再创建或弹窗冲突，提取器对中相似内容静默跳过，
  // 存量去重自动合并。用户零打扰。
  pi.on("agent_settled", async (_event: any, ctx: any) => {
    try {
      store.reload(); // 同步卡片/外部对 JSON 的修改
      const entries = ctx.sessionManager?.getBranch?.() ?? [];
      const messages = entries
        .filter((e: any) => e.type === "message")
        .map((e: any) => e.message)
        .filter(Boolean);

      if (messages.length < 2) return;

      const result = await extractor.extract(messages, ctx.modelRegistry, sessionId);
      if (result.added === 0) return;

      store.save();
      updateMemoryWidget(ctx, store);
      const data = { version: 1, updatedAt: Date.now(), memories: store.getAll() };
      writeIndexMd(storeDir, data);
      ctx.ui.setStatus("mem-spaced", `${store.getActive().length} 条记忆`);
      ctx.ui.notify(`🧠 自动记忆: 新增 ${result.added} 条`, "info");
    } catch { /* 静默失败 */ }
  });

  // ─── session_shutdown: 持久化 ───
  pi.on("session_shutdown", async () => {
    store.save();
    const data = { version: 1, updatedAt: Date.now(), memories: store.getAll() };
    writeIndexMd(storeDir, data);
  });

  // ─── 注册命令和工具 ───
  registerCommands(pi as any, store, injector);
  registerTools(pi, store);
}
