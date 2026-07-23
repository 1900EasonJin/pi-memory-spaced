# pi-memory-spaced 完整修复计划

## 目标

修复已确认的重注入、数据覆盖、重复衰减、重复提取、误去重、路径污染和隐私边界问题；仅修改当前扩展，不修改 PiDeck 项目源码。

## 行为决策

1. `memory-store.json` 继续作为唯一数据源，保留现有条目和旧字段兼容。
2. 所有扩展写入改为“读取最新数据 → 内存变更 → 原子替换”，session 结束不再盲目覆盖磁盘。
3. Store 增加内存 revision；注入快照绑定 `revision + 目标路径`，记忆变化或路径变化后自动重建。
4. 衰减增加 `lastDecayedAt` 基准，同一时间段只衰减一次；低于阈值改为归档、不再物理删除。
5. 统一阈值为：归档 `<0.10`，低效 `0.10~0.15`，与现有 README/PiDeck 协议一致。
6. 自动去重只合并归一化后完全相同的条目；语义相似但可能相反的内容不再自动删除。
7. 恢复读取旧 `resolvedSources` 哈希，已处理内容不再由自动提取器重新加入。
8. 自动提取只分析当前最后一轮用户对话，排除工具输出，并使用当前会话模型/提供商。
9. 自动提取结果执行运行时类型、长度、标签和路径数量校验。
10. 注入内容使用明确的数据边界和 JSON 转义，降低持久化提示注入风险。
11. 路径关联只采集结构化 `read/edit/write` 参数；删除 bash 输出正则抓路径的逻辑，只返回真正命中的关联记忆。
12. `memory_recall` 限制返回条数和输出长度；RPC 模式不再误走 TUI 自定义组件。

## TDD 顺序

### RED

新增失败测试覆盖：

- 合并或删除后旧快照不得继续包含被删 ID。
- 外部磁盘修改后 `reloadIfChanged()` 必须更新 Store revision。
- 连续两次相同时间衰减不得重复降低 potency。
- 低效记忆保留在 Store，但不进入可注入集合。
- 相反语义的高文本相似内容不得被自动合并。
- 合并必须保留 tenured、时间和来源元数据。
- 路径切换必须重建快照；无路径命中不得返回普通 Top-N。
- 自动提取只保留最后一轮消息并排除工具结果。
- 损坏 JSON 必须报错且不得被空库覆盖。

### GREEN

按最少改动修改：

- `src/types.ts`
- `src/store.ts`
- `src/injector.ts`
- `src/extractor.ts`
- `src/path-assoc.ts`
- `src/index.ts`
- `src/tools.ts`
- `src/commands.ts`
- `src/index-md.ts`
- `README.md`
- `__tests__/*.test.ts`
- `package.json`（补充统一测试脚本）

### REFACTOR

删除失效的 `turnCounter/snapshotTurn`、死代码和过时注释，保持文件数量和依赖不增加。

## 验证

1. `npm test`
2. `git diff --check`
3. 使用临时 JSON 运行外部修改、损坏文件、连续 session 衰减和快照重建复现。
4. 使用 Pi 的 jiti 加载入口，确认扩展模块可正常初始化。
5. 检查真实 `~/.pi/agent/memory-store.json` 只读兼容，不在测试中修改真实数据。

## 不包含

- 不修改 `pideck-dev-git-enhance`。
- 不自动清理当前真实记忆内容。
- 不执行 commit 或 push。
