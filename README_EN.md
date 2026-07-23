# pi-memory-spaced 🧠

[中文文档](./README.md)

A spaced-repetition-driven memory system for Pi Agent.

> Give Pi Agent a memory that truly "forgets" — what matters resurfaces, what doesn't sinks.

Designed to pair with [PiDeck](https://github.com/ayuayue/PiDeck), the desktop environment for Pi Agent (also works in plain Pi CLI).

## Installation

```bash
# Install from GitHub (recommended)
pi install git:https://github.com/1900EasonJin/pi-memory-spaced.git

# Or local development
git clone https://github.com/1900EasonJin/pi-memory-spaced.git
cd pi-memory-spaced
pi -e ./src/index.ts
```

## How It Works

### Spaced Repetition
Every memory carries a **potency score (0~1)** that decays exponentially over time and is boosted whenever the memory is injected into context. Low-scoring memories are archived automatically.

```
potency curve:
  new memory → 0.8 ──→ ×0.95 per day ──→ archived below 0.1
             ↑                          │
             └── +0.3 when used ────────┘
```

### Automatic Extraction
After every conversation turn (`agent_settled`), the current session model analyzes only the last turn of user/assistant messages and extracts decisions, conventions, patterns, preferences, facts, and lessons worth remembering long-term. Tool output is never sent to the extraction model.

### Safe Deduplication
New memories are checked with character-overlap similarity, handled conservatively:
- Identical after normalization → merged, preserving tenure state, source, timestamps, paths/tags
- Highly similar auto-extracted content (≥0.8) → not added; merged into the existing entry instead (paths/tags union + potency boost), original text untouched
- Similar content added manually by the user → kept as-is, since it may be a correction, negation, or new convention

### Automatic Consolidation
Memories in the "related but different" similarity band (0.3~0.8) are consolidated in the background, so one topic never splinters into a dozen entries:

- **Trigger**: checked after every turn — when a new memory was added and active memories exceed 30, or when 24 hours have passed since the last run
- **Clustering**: local 2-gram similarity ≥0.3 with union-find; zero LLM cost when no clusters exist
- **Merging**: the current session model synthesizes each cluster into one richer memory (paths/tags/accessCount union, max potency)
- **Safety**: memories spoken via "记住：" (user source) and tenured memories are never auto-merged; the LLM can veto a cluster that shouldn't merge; the store is backed up to `memory-store.backup.json` before every write

Legacy `resolvedSources` hashes written by PiDeck remain honored — previously handled content never re-enters the store automatically.

**Threshold convention**: the extension shares the same potency tiers as the PiDeck MemSpacedCard:
- `≥0.15` → active
- `0.10~0.15` → low-efficiency
- `<0.10` → archived (kept in the store, but never auto-injected)

### Memory Palace (Path Association)
Memories can be associated with file paths. When the Agent works on a file, memories linked to that path are injected first.

## Usage

### Spoken Commands
Just say it — the system intercepts and stores it:
```
记住：这个项目使用 pnpm 作为包管理器
记一下：API 请求需要带 token
请记住：测试数据库用 SQLite
```

### Commands (interactive mode)

| Command | Purpose |
|---------|---------|
| `/mem:status` | Overview (active/archived counts, current injection snapshot) — PiDeck dashboard |
| `/mem:list` | Interactively browse all active memories (sorted by potency) — view details / delete |
| `/mem:search <keyword>` | Search memories with interactive browsing |
| `/mem:forget <id>` | Delete a memory (interactive picker when no ID given) |
| `/mem:add <type> <content>` | Add manually (types: decision/convention/pattern/preference/fact/lesson) |

RPC mode falls back to text notifications and never invokes TUI-only custom components.

### LLM Tools

The Agent can call these proactively during conversation:
- `memory_recall(query)` — search long-term memory
- `memory_remember(type, content, paths?)` — explicitly tell the Agent to remember

## PiDeck UI Features

The plugin is optimized for the [PiDeck](https://github.com/ayuayue/PiDeck) desktop environment:

### Persistent Status Widget
A memory stats line is always visible above the input box:
```
🧠 24 active
🔥 This project uses pnpm as its package manager
```
The widget refreshes on every memory change.

### Interactive Commands
In the PiDeck TUI, all list-style commands use SelectList components:
1. **↑↓ navigate** — move through memories
2. **Enter select** — view memory details (type, potency, tags, paths, full content)
3. **Action menu** — choose "delete" or "back to list" on the detail page
4. **Esc cancel** — exit the current screen

### Dashboard
`/mem:status` renders a full system status panel:
- Total / active / archived counts
- Injection snapshot info
- Top-5 highest-priority memories

### Non-TUI Environments
RPC mode uses text notifications; in print/json mode Pi's UI notifications are no-ops by design.

## Data Files

```
~/.pi/agent/
├── MEMORY.md           ← human-readable memory index (plain Markdown, open directly)
└── memory-store.json   ← structured data (potency / paths / tags)
```

## Architecture

```
┌─ Perception ─────────────────────────┐
│  input (spoken "记住" interception)   │
│  agent_settled (LLM auto-extraction) │
│  tool_call (path collection)         │
└──────────────┬───────────────────────┘
               ▼
┌─ Storage ────────────────────────────┐
│  Memory Store                        │
│  ├─ Incremental decay & non-destructive archiving │
│  ├─ Exact dedup & resolvedSources compatibility   │
│  └─ Locked read-modify-write + atomic persistence │
└──────────────┬───────────────────────┘
               ▼
┌─ Retrieval ──────────────────────────┐
│  before_agent_start context injection│
│  ├─ Path-association first (memory palace)        │
│  ├─ potency ranking                               │
│  └─ Store revision + path snapshot                │
└──────────────────────────────────────┘
```

## Development

```bash
# Install dependencies (tests only)
npm install

# Run all core and regression tests
npm test

# Load locally
pi -e ./src/index.ts
```

## License

MIT
