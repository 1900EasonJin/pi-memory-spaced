# pi-memory-spaced 🧠

间隔重复驱动的 Pi Agent 记忆系统。

> 让 Pi Agent 拥有真正"会遗忘"的记忆——重要的事反复出现，不重要的事自动沉底。

## 安装

```bash
# 从 GitHub 安装（推荐）
pi install git:https://github.com/1900EasonJin/pi-memory-spaced.git

# 或本地开发测试
git clone https://github.com/1900EasonJin/pi-memory-spaced.git
cd pi-memory-spaced
pi -e ./src/index.ts
```

## 机制

### 间隔重复
每条记忆有 **效力分数（potency）**，随时间指数衰减，被注入上下文时增强。低分自动归档。

```
potency 变化曲线：
  新记忆 → 0.8 ──→ 每天 ×0.95 ──→ 低于 0.1 归档
             ↑                        │
             └── 被使用时 +0.3 ───────┘
```

### 自动提取
每轮对话结束后（`agent_settled`），当前会话模型只分析最后一轮用户/助手消息，提取需要长期记住的决策、约定、模式、偏好、事实和经验教训。工具输出不会发送给提取模型。

### 安全去重
新记忆仍会计算字符重叠相似度，但自动处理遵循保守规则：
- 归一化后完全相同 → 合并并保留固化状态、来源、时间、paths/tags
- 自动提取的高相似内容 → 跳过，不覆盖已有记忆
- 用户手动添加的相似内容 → 保留，因为它可能是纠正、否定或新约定

旧版 PiDeck 写入的 `resolvedSources` 哈希继续生效，已经处理过的内容不会再次自动入库。

**阈值约定**：扩展与 PiDeck MemSpacedCard 使用一致的 potency 分级：
- `≥0.15` → 活跃
- `0.10~0.15` → 低效记忆
- `<0.10` → 已归档（保留在 Store，但不自动注入）

### 记忆宫殿（路径关联）
每条记忆可关联文件路径。Agent 操作文件时，关联该路径的记忆优先注入。

## 用法

### 口语指令
直接说，系统会拦截并存入记忆库：
```
记住：这个项目使用 pnpm 作为包管理器
记一下：API 请求需要带 token
请记住：测试数据库用 SQLite
```

### 命令（互动模式下输入）

| 命令 | 用途 |
|------|------|
| `/mem:status` | 查看总览（活跃/归档/冲突数量、当前注入快照） — PiDeck 仪表盘 |
| `/mem:list` | 交互式浏览所有活跃记忆（按效力排序）— 进入可查看详情/删除 |
| `/mem:search <关键词>` | 搜索记忆，交互式浏览结果 |
| `/mem:forget <id>` | 删除指定记忆（无 ID 时进入交互式选择） |
| `/mem:add <类型> <内容>` | 手动添加（类型：decision/convention/pattern/preference/fact/lesson） |


RPC 模式使用文本通知，不会误调用仅 TUI 可用的自定义组件。

### LLM 工具

Agent 在对话中可主动调用：
- `memory_recall(query)` — 搜索长期记忆
- `memory_remember(type, content, paths?)` — 手动告诉 Agent 记住

## PiDeck UI 特性

插件为 PiDeck 桌面环境做了专门优化：

### 持久状态 Widget
输入框上方始终显示记忆统计：
```
🧠 24 活跃
🔥 项目使用 pnpm 作为包管理器
```
Widget 在每一次记忆变更后自动刷新。

### 交互式命令
在 PiDeck TUI 下，所有列表类命令使用 SelectList 组件：
1. **↑↓ 导航** — 在记忆中上下移动
2. **Enter 选中** — 查看记忆详情（类型、效力、标签、路径、完整内容）
3. **操作菜单** — 在详情页可选择「删除」或「返回列表」
4. **Esc 取消** — 退出当前界面

### 仪表盘
`/mem:status` 显示一个完整的系统状态面板：
- 总条目/活跃/已归档计数
- 注入快照信息
- Top-5 高优先级记忆



### 非 TUI 环境
RPC 模式使用文本通知；print/json 模式下 Pi 的 UI 通知本身为 no-op。

## 数据文件

```
~/.pi/agent/
├── MEMORY.md           ← 人类可读的记忆索引（纯 Markdown，可直接打开）
└── memory-store.json   ← 结构化数据（含 potency/路径/标签）
```

## 核心架构

```
┌─ 感知层 ─────────────────────────────┐
│  input（口语"记住"拦截）              │
│  agent_settled（LLM 自动提取）        │
│  tool_call（路径收集）                │
└──────────────┬───────────────────────┘
               ▼
┌─ 存储层 ─────────────────────────────┐
│  Memory Store                        │
│  ├─ 增量衰减与非破坏归档              │
│  ├─ 精确去重与 resolvedSources 兼容   │
│  └─ 锁定读改写 + 原子替换持久化       │
└──────────────┬───────────────────────┘
               ▼
┌─ 检索层 ─────────────────────────────┐
│  before_agent_start 注入上下文        │
│  ├─ 路径关联优先（记忆宫殿）           │
│  ├─ potency 排序                     │
│  └─ Store revision + 路径快照        │
└──────────────────────────────────────┘
```

## 开发

```bash
# 安装依赖（仅测试需要）
npm install

# 运行全部核心与回归测试
npm test

# 本地加载
pi -e ./src/index.ts
```

## 许可证

MIT
