/**
 * 路径关联模块 — 记忆宫殿的轻量实现
 *
 * 核心思路：将记忆"锚定"到文件路径上。
 * 当 Agent 操作某个文件时，关联到该路径（或父目录）的记忆会被优先注入。
 */

/** 从一组工具调用参数中提取文件路径 */
export function extractPathsFromToolCalls(toolCalls: Array<{ name: string; args: Record<string, any> }>): string[] {
  const paths = new Set<string>();
  for (const tc of toolCalls) {
    if (tc.name === "read" && tc.args.path) paths.add(tc.args.path);
    if (tc.name === "edit" && tc.args.path) paths.add(tc.args.path);
    if (tc.name === "write" && tc.args.path) paths.add(tc.args.path);
    if (tc.name === "bash" && typeof tc.args.command === "string") {
      // 从 bash 命令中提取可能的文件路径
      const matches = tc.args.command.match(/(?:\/[\w.-]+)+/g);
      if (matches) for (const m of matches) paths.add(m);
    }
  }
  return [...paths];
}

/** 从 session 消息历史中收集所有被操作过的路径 */
export function collectSessionPaths(entries: any[]): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "toolResult") {
      if (msg.details?.filePath) paths.add(msg.details.filePath);
      if (msg.details?.path) paths.add(msg.details.path);
    }
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "toolCall" && block.name === "read" && block.arguments?.path) {
          paths.add(block.arguments.path);
        }
        if (block.type === "toolCall" && block.name === "edit" && block.arguments?.path) {
          paths.add(block.arguments.path);
        }
        if (block.type === "toolCall" && block.name === "write" && block.arguments?.path) {
          paths.add(block.arguments.path);
        }
      }
    }
  }
  return [...paths];
}

/** 计算路径层级深度 */
export function pathDepth(filePath: string): number {
  return filePath.split("/").filter(Boolean).length;
}

/** 获取路径的所有父目录 */
export function getPathAncestors(filePath: string): string[] {
  const parts = filePath.split("/").filter(Boolean);
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push("/" + parts.slice(0, i).join("/") + "/");
  }
  return ancestors;
}

/**
 * 判断两条路径是否关联（相等、父子目录、兄弟文件）
 * 返回关联强度 0~1
 */
export function pathAffinity(a: string, b: string): number {
  if (a === b) return 1.0;
  const normalizedA = a.endsWith("/") ? a : a + "/";
  const normalizedB = b.endsWith("/") ? b : b + "/";

  if (normalizedA.startsWith(normalizedB) || normalizedB.startsWith(normalizedA)) return 0.6;

  // 兄弟文件（同一目录下）
  const dirA = a.substring(0, a.lastIndexOf("/") + 1);
  const dirB = b.substring(0, b.lastIndexOf("/") + 1);
  if (dirA === dirB) return 0.4;

  return 0;
}
