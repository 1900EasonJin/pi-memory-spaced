/**
 * 路径关联模块 — 记忆宫殿的轻量实现
 *
 * 核心思路：将记忆"锚定"到文件路径上。
 * 当 Agent 操作某个文件时，关联到该路径的记忆会被优先注入。
 *
 * 跨 turn 累积：tool_call 中收集的路径被暂存，
 * 在下一轮 before_agent_start 时取出传给 injector。
 */

const accumulatedPaths = new Set<string>();

/** 从一组工具调用参数中提取文件路径 */
function extractPathsFromToolCalls(toolCalls: Array<{ name: string; args: Record<string, any> }>): string[] {
  const paths = new Set<string>();
  for (const tc of toolCalls) {
    if (tc.name === "read" && tc.args.path) paths.add(tc.args.path);
    if (tc.name === "edit" && tc.args.path) paths.add(tc.args.path);
    if (tc.name === "write" && tc.args.path) paths.add(tc.args.path);
  }
  return [...paths];
}

/** 累积一条 tool_call 的路径 */
export function accumulateToolCallPath(toolName: string, args: Record<string, any>): void {
  for (const p of extractPathsFromToolCalls([{ name: toolName, args }])) {
    accumulatedPaths.add(p);
  }
}

/** 取出所有累积路径并清空 */
export function drainAccumulatedPaths(): string[] {
  const paths = [...accumulatedPaths];
  accumulatedPaths.clear();
  return paths;
}
