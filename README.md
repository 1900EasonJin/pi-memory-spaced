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
每轮对话结束后（`agent_settled`），LLM 自动分析对话，提取需要长期记住的信息：决策、约定、模式、偏好、事实、经验教训。

### 自动去重合并
新记忆与已有记忆做关键词重叠相似度比对：
- **≥80%**（高相似）→ 自动合并到已有记忆（保留 potency 高者，paths/tags 取并集）
- **55~80%**（中相似）→ 自动合并（低 potency→高 potency）
- **<55%** → 作为新记忆添加

`agent_settled` 时的 LLM 提取结果中，中高相似度内容自动跳过/合并，用户零打扰。

**阈值约定**：扩展与 PiDeck MemSpacedCard 使用一致的 potency 分级：
- `≥0.1` → 活跃
- `0.1~0.15` → 低效记忆（即将归档）
- `<0.1` → 已归档
- 扩展 `archiveThreshold: 0.1`，卡片 `ARCHIVE_THRESHOLD: 0.1`

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


非 TUI 环境（RPC/print 模式）下所有命令自动 fallback 到文本 notify 输出。

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
当 `ctx.hasUI` 为 false（RPC/print 模式）时，所有命令自动恢复为文本 notify 输出，保证兼容性。

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
│  ├─ 间隔重复效力衰减                  │
│  ├─ 相似度去重检测                    │
│  └─ 持久化到 ~/.pi/agent/            │
└──────────────┬───────────────────────┘
               ▼
┌─ 检索层 ─────────────────────────────┐
│  before_agent_start 注入上下文        │
│  ├─ 路径关联优先（记忆宫殿）           │
│  ├─ potency 排序                     │
│  └─ KV 缓存稳定快照                  │
└──────────────────────────────────────┘
```

## 开发

```bash
# 安装依赖（仅测试需要）
npm install

# 运行测试
node --experimental-strip-types __tests__/store.test.ts

# 本地加载
pi -e ./src/index.ts
```

## 许可证

MIT
