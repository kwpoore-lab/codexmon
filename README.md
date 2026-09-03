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

**Running now** — one full panel *per active agent* (any session written to in the last 15s,
or mid-turn). Each panel:

- title (`~/.codex/session_index.jsonl`), project + git repo/branch, model / effort / tier / client
- **session prompt** — the opening user message — plus the latest message if different
- token stat line: total, context-window fill %, input / cached / output / reasoning
- **consumption-over-time chart**: cumulative tokens (area/line) with per-turn tokens as bars
- **Commands, latest first**: time · command · Δ tokens (consumed after that step) · running total
- **Consumption by base command**: the same commands grouped by base verb with parameters
  stripped (`git status`, `sed`, `apply_patch`, `rg`, …) — runs + summed Δ tokens, biggest first

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
