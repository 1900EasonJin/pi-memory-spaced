import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { MemoryEntry, MemoryStoreData } from "./types.ts";

const TYPE_ICON: Record<string, string> = {
  decision: "🎯",
  convention: "📐",
  pattern: "🔁",
  preference: "⭐",
  fact: "📌",
  lesson: "💡",
};

function formatPotency(p: number): string {
  if (p >= 0.8) return "🔥";
  if (p >= 0.5) return "⭐";
  if (p >= 0.3) return "·";
  return "○";
}

function memoryLine(m: MemoryEntry): string {
  const icon = TYPE_ICON[m.type] ?? "📝";
  const potencyBadge = formatPotency(m.potency);
  return `- [${m.type}] ${potencyBadge} ${m.content} (p:${m.potency.toFixed(2)})`;
}

/** 生成 MEMORY.md 内容 */
export function generateIndexMd(data: MemoryStoreData, maxLines = 50): string {
  const lines: string[] = [];
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  lines.push("# 🧠 记忆索引");
  lines.push("> 由 pi-memory-spaced 自动维护");
  lines.push(`> 最后更新: ${now}`);
  lines.push("");

  // 活跃记忆按 potency 排序
  const active = data.memories.filter((m) => m.potency >= 0.1).sort((a, b) => b.potency - a.potency);
  const topN = active.slice(0, maxLines - 10);

  if (topN.length > 0) {
    lines.push("## 高优先级记忆");
    for (const m of topN) lines.push(memoryLine(m));
    lines.push("");
  }

  // 按主题归类
  const topicMap = new Map<string, number>();
  for (const m of data.memories) {
    for (const tag of m.tags) {
      topicMap.set(tag, (topicMap.get(tag) ?? 0) + 1);
    }
  }
  if (topicMap.size > 0) {
    lines.push("## 按主题");
    lines.push("| 主题 | 条目数 |");
    lines.push("|------|--------|");
    for (const [tag, count] of [...topicMap.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${tag} | ${count} |`);
    }
    lines.push("");
  }

  // 统计
  lines.push("---");
  lines.push(`共 ${data.memories.length} 条记忆，活跃 ${active.length} 条`);

  return lines.join("\n");
}

/** 写入 MEMORY.md */
export function writeIndexMd(dirPath: string, data: MemoryStoreData, maxLines?: number): string {
  const content = generateIndexMd(data, maxLines);
  const indexPath = join(dirPath, "MEMORY.md");
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, content, "utf-8");
  return indexPath;
}
