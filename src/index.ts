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
import { accumulateToolCallPath, drainAccumulatedPaths } from "./path-assoc.ts";
import { registerCommands, updateMemoryWidget } from "./commands.ts";
import { registerTools } from "./tools.ts";
import { join } from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
  const storeDir = join(homedir(), ".pi", "agent");
  const store = new MemoryStore({ storePath: join(storeDir, "memory-store.json") });
  const injector = new MemoryInjector(store);
  const extractor = new MemoryExtractor(store);
  let sessionId = "";

  const refreshMemoryUi = (ctx: any): void => {
    writeIndexMd(
      storeDir,
      { version: 1, updatedAt: Date.now(), memories: store.getAll() },
      undefined,
      store.getConfig().archiveThreshold,
    );
    updateMemoryWidget(ctx, store);
    ctx.ui.setStatus("mem-spaced", `${store.getInjectable().length} 条记忆`);
  };

  // ─── session_start: 从磁盘最新版本执行一次增量衰减 ───
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionId = ctx.sessionManager?.getSessionId() ?? "unknown";
    store.mutate(() => store.applyDecay());
    injector.invalidateSnapshot();
    refreshMemoryUi(ctx);
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

    const result = store.mutate(() => {
      const check = store.dedupeCheck(content);
      if (check.level === "exact") {
        const top = check.matches[0];
        store.update(top.entry.id, { potency: Math.min(1, top.entry.potency + 0.1) });
        return { duplicate: top.entry.content, similarity: top.similarity };
      }

      // 只有完全相同才强化；相似但不同可能是用户纠正，必须保留。
      store.add({
        type: "preference",
        content: content.slice(0, store.getConfig().maxMemoryLength),
        paths: [],
        potency: 0.9,
        source: "user",
        tags: [],
        sourceSession: sessionId,
      });
      return { duplicate: undefined, similarity: 0 };
    });

    refreshMemoryUi(ctx);
    if (result.duplicate) {
      ctx.ui.notify(`⚠️ 已有完全相同记忆，已强化:\n${result.duplicate.slice(0, 80)}`, "info");
    } else {
      ctx.ui.notify(`✅ 已记住: ${content.slice(0, 80)}`, "info");
    }
    return { action: "handled" as const };
  });

  // ─── before_agent_start: 注入记忆到上下文 ───
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const targetPaths: string[] = [];
    if (event.prompt) {
      const pathMatches = event.prompt.match(/(?:\/[\w.-]+)+/g);
      if (pathMatches) targetPaths.push(...pathMatches);
    }
    targetPaths.push(...drainAccumulatedPaths());

    const snapshot = injector.build(targetPaths);
    refreshMemoryUi(ctx);
    if (snapshot.text) return { systemPrompt: event.systemPrompt + snapshot.text };
  });

  // ─── tool_call: 累积路径供下一轮注入 ───
  pi.on("tool_call", async (event: any, _ctx: any) => {
    accumulateToolCallPath(event.toolName, event.input);
  });

  // ─── session_before_compact: 刷新快照 ───
  pi.on("session_before_compact", async () => { injector.invalidateSnapshot(); });

  // ─── agent_settled: 只分析当前最后一轮，提取器内部原子保存 ───
  pi.on("agent_settled", async (_event: any, ctx: any) => {
    try {
      const entries = ctx.sessionManager?.getBranch?.() ?? [];
      const messages = entries
        .filter((entry: any) => entry.type === "message")
        .map((entry: any) => entry.message)
        .filter(Boolean);
      const result = await extractor.extract(messages, ctx.modelRegistry, sessionId, ctx.model);
      store.reloadIfChanged();
      refreshMemoryUi(ctx);
      if (result.added > 0) ctx.ui.notify(`🧠 自动记忆: 新增 ${result.added} 条`, "info");
    } catch (error) {
      ctx.ui.notify(`⚠️ 记忆提取异常: ${error}`, "error");
    }
  });

  // 所有变更均已即时原子保存，shutdown 不再用旧内存覆盖外部修改。
  pi.on("session_shutdown", async () => { injector.invalidateSnapshot(); });

  // ─── 注册命令和工具 ───
  registerCommands(pi as any, store, injector, refreshMemoryUi);
  registerTools(pi, store, refreshMemoryUi);
}
