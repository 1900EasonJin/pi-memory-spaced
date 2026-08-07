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
Every memory carries a **potency score (0~1)** that decays exponentially over time. Low-scoring memories are archived automatically (no longer injected).

```
potency curve:
  new memory → 0.8 ──→ ×0.95 per day ──→ archived below 0.2
             ↑              ↑
             └── +0.01 per new independent evidence (evidenceCount+1)
             └── +0.03 per recall hit (recallHitCount+1, decay anchor reset)
```

**Reinforcement only comes from new evidence and recall hits — injection/reading never boosts potency**: being injected only increments `accessCount` (which may promote the memory to tenured), without touching potency or the decay anchor, so heavily used memories still decay over time.

### Closed-Loop Feedback (Engineering Cybernetics)
The system is **closed-loop**, not open-loop: a `memory_recall` hit means successful retrieval (review success) — the hit strengthens potency and resets the decay anchor. Passive injection never strengthens; only active retrieval success does.

### Self-Optimizing (Engineering Cybernetics)
The decay factor is not a hard-coded constant: the system tracks the real hit rate (recall hits / injections) over a 7-day window and adjusts itself when the window matures with ≥30 samples:

- Hit rate ≥ 0.3 → memory is actually useful, loosen decay (+0.01, capped at 0.97, keep longer)
- Hit rate < 0.05 → injections barely used, tighten decay (−0.01, floored at 0.90, forget faster, less pollution)
- Not enough samples → no adjustment (no measurement, no control)

`/mem:status` shows the currently active decay factor.

### Automatic Extraction
Triggered once per session once user messages reach ≥3 turns (`agent_settled`); the current session model analyzes the **entire session** of user/assistant messages. Tool output is never sent to the extraction model.

**Hard gate (not relying on model honesty)**: every candidate must explicitly declare `kind` and `durable` —
- `kind`: `preference` / `workflow` / `constraint` / `lesson` / `decision` / `project_fact`
- `durable !== true` or `kind === "project_fact"` → discarded at parse time

Rejected: current branch/commit state, file paths, build artifacts, one-off errors and fixes, transient progress, facts re-readable from the repo, time-decaying snapshots. A single occurrence never implies a preference unless the user says so explicitly (e.g. "always do it this way from now on").

### Safe Deduplication
New memories are checked with character-overlap similarity, handled conservatively:
- **Match (similarity ≥ 0.45, incl. exact/high/mid) → reinforce, never insert**: `evidenceCount+1`, potency +0.01, paths/tags union; original text untouched (high similarity may be a correction or negation — never overwrite blindly)
- **No match (< 0.45) → allowed to insert** (subject to quotas)
- Similar content added manually by the user → kept as-is, since it may be a correction, negation, or new convention

### Automatic Consolidation
Memories in the "related but different" similarity band (0.3~0.8) are consolidated in the background, so one topic never splinters into a dozen entries:

- **Trigger**: checked after every turn — when a new memory was added and active memories exceed 30, or when 24 hours have passed since the last run
- **Clustering**: local 2-gram similarity ≥0.3 with union-find; zero LLM cost when no clusters exist
- **Merging**: the current session model synthesizes each cluster into one richer memory (paths/tags/accessCount union, max potency)
- **Safety**: memories spoken via "记住：" (user source) and tenured memories are never auto-merged; the LLM can veto a cluster that shouldn't merge; the store is backed up to `memory-store.backup.json` before every write

Legacy `resolvedSources` hashes written by PiDeck remain honored — previously handled content never re-enters the store automatically.

**Threshold convention**: the extension shares the same potency tiers as the PiDeck MemSpacedCard:
- `≥0.30` → active
- `0.20~0.30` → low-efficiency
- `<0.20` → archived (kept in the store, but never auto-injected)

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
