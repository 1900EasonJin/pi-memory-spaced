# 记忆自动整合方案（Memory Consolidation）

## 问题

当前扩展只管「加」和「衰减」，不管「合」：

| 档位 | 相似度 | 现状行为 | 问题 |
|------|--------|----------|------|
| exact | 归一化相同 | 强化旧条目 | ✅ 正常 |
| high | ≥0.8 | **直接丢弃新记忆**（extractor.ts `continue`） | 新信息丢失 |
| mid | 0.45~0.8 | 直接新增 | **相关记忆堆积，永不合并** ← 核心痛点 |
| dedupeAll | — | 只合并归一化完全相同的 | 语义相近的合不了 |

结果：同一主题（如「PPT 字号偏好」）会裂成多条记忆，互相稀释 potency，抢占注入预算。

## 方案（按改动量从小到大）

### P0：high 档从「丢弃」改为「合并强化」（约 5 行）

`extractor.ts` 中 `check.level === "high"` 分支不再 `continue`，复用 exact 分支的合并逻辑：
paths/tags 取并集、potency +0.05。内容保持旧条目原文（高相似但可能是纠正，不冒险改内容）。

### P1：LLM 整合器 Consolidator（核心，新文件约 100 行）

新增 `src/consolidator.ts`，流程：

1. **触发时机**：`agent_settled` 提取完成后，满足任一条件才跑：
   - 本轮新增 > 0 且活跃记忆总数 > 30
   - 距上次整合超过 24 小时
   （节流：整合 = 1~2 次 LLM 调用，不能每轮都跑）
2. **聚类**：用现有 `similarity()`（2-gram，零成本）对全部活跃记忆两两比对，
   ≥0.3 的并查集连成簇，只处理 2~8 条的簇。
   （阈值低于入库闸门 0.45——实测真实库中相关记忆对相似度仅 0.3~0.45，
   靠下一步的 LLM 否决权兜底误聚）
3. **LLM 合并**：每个簇一次调用，prompt 要求：
   - 合并成一条更完整的记忆（≤200 字）
   - **若簇内存在纠正/冲突关系，保留 `user` 来源或最新的表述**
   - **若判定这些记忆并非同一主题，返回 `mergedContent: null` 否决该簇**
   - 返回 JSON：`{ mergedContent }`
4. **落库**：`store.mutate()` 内原子执行——新增合并条目（paths/tags/accessCount 并集，
   potency 取簇内最大值），删除被合并条目。
5. **安全网**：
   - 合并前把 `memory-store.json` 复制为 `memory-store.backup.json`（覆盖式，只留一份）
   - `source === "user"` 的记忆不参与自动合并（用户口语「记住：」的优先级最高）
   - 完成后 `ctx.ui.notify("🧠 整合了 N 条记忆 → M 条")`

### P2：手动命令（可选，先不做）

- `/mem:consolidate`：手动触发 P1，先预览合并计划再确认
- `/mem:merge`：TUI 选两条手动合并

P1 稳定运行一段时间后确实需要再加。

## 不做的事

- 不引入向量 embedding——2-gram 在实测阈值上已够用，加依赖违背轻量原则
- 不做「记忆图谱/关联网络」——over-engineering
- 不改注入/衰减逻辑——它们没坏

## 状态：已实施（P0+P1）

- 验证：`npm test` 三套全绿（59 + 25 + 20 断言）
- 真实库 dry-run：15 条活跃记忆检出 2 个簇（飞书按钮×2、「打开应用」×2），无误聚

## 验证方式

1. `__tests__` 新增：构造 3 条相似记忆 → 跑 consolidator → 断言只剩 1 条且字段并集正确
2. 手动验证：对现有 `~/.pi/agent/memory-store.json`（已有多条 PPT 偏好重复）跑一次，
   检查合并结果和 backup 文件
3. 回归：现有 `store.test.ts` / `regression.test.ts` 全绿

## 改动清单

| 文件 | 改动 |
|------|------|
| `src/extractor.ts` | P0：high 档合并代替丢弃（~5 行） |
| `src/consolidator.ts` | P1：新文件（~150 行） |
| `src/index.ts` | 挂载 consolidator 触发逻辑（~15 行） |
| `__tests__/consolidator.test.ts` | 新测试 |
