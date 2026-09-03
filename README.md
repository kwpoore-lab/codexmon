# codexmon

Live + historical monitor for Codex CLI usage, reading `~/.codex/sessions/**/rollout-*.jsonl`.

## Run

```bash
node server.js            # http://localhost:4317
node server.js --port 8080 --root ~/.codex
```

Zero dependencies (Node stdlib only). Open the URL in a browser.

## What it shows

Refreshed every 2s over Server-Sent Events.

**Running now** — one panel *per active agent* (any session written to in the last 15s, or
mid-turn). Collapsed by default so many agents fit on one screen; click the ▸ caret to expand.

Collapsed shows: title, age, active-turn flag, a one-line token/ctx/cmd/turn summary,
project · model · effort · tier, the latest message, and the **consumption-over-time chart**
(cumulative tokens as area/line, per-turn tokens as bars).

Expanded adds: cwd + full badges, the full **session prompt** and latest message, the token
breakdown (total / ctx window / in / cached / out / reasoning), and two tables —

- **Commands, latest first**: time · command · Δ tokens (consumed after that step) · running total
- **Consumption by base command**: the same commands grouped by base verb with parameters
  stripped (`git status`, `sed`, `apply_patch`, `rg`, …) — runs + summed Δ tokens, biggest first

"% ctx" is the last request's input tokens over the model context window (real occupancy) —
not the cumulative session total, which far exceeds the window.

**Other live sessions** — compact cards for everything else touched in the last 15 min,
subagents nested under their parent, dot = 🟢 running / 🟡 idle.

**History** — pick a date; table of every session that day (main + subagents) with the prompt,
model, token total, command count. Click any row (or card) for the detail panel:
full message/tool/reasoning timeline, the consumption chart, base-command breakdown, and metadata.

## How it works

- Incremental tail-read: each file is parsed once, then only newly-appended bytes on each tick
  (the active session file is already >10 MB).
- `source` in `session_meta` is polymorphic — a string for main threads, an object with
  `subagent.thread_spawn` for spawned agents; both are handled.
- `codex-auto-review` turns are tracked as a separate flag, not counted as the primary model.
- Codex tool calls are JS snippets (`tools.exec_command({cmd:"…"})`); `extractCmd()` digs out the
  real shell string (string, array, or template-literal form, plus `apply_patch`).
- Per-command token cost is approximate: tokens accrue between a command and the next
  `token_count` event and are attributed to the preceding command.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | UI |
| `GET /events` | SSE stream of the live snapshot |
| `GET /api/dates` | available history dates |
| `GET /api/sessions?date=YYYY-MM-DD` | session summaries for a day |
| `GET /api/session/:uuid` | full timeline + summary |
