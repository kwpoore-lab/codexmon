#!/usr/bin/env node
'use strict';

/*
 * codexmon — live + historical monitor for ~/.codex/sessions
 * Zero dependencies. Node stdlib only.
 *
 *   node server.js [--port 4317] [--root ~/.codex]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const PORT = parseInt(argVal('--port', process.env.PORT || '4317'), 10);

const TICK_MS = 2000;          // rescan cadence
const LIVE_WINDOW_MS = 15 * 60 * 1000;   // show in live feed if touched within this
const RUNNING_MS = 15 * 1000;  // green dot
const IDLE_MS = 5 * 60 * 1000; // yellow dot

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Resolve the Codex home directory. Codex itself honours $CODEX_HOME and
// otherwise uses ~/.codex, so mirror that, then fall back to a few common
// spots and finally a shallow scan. A valid root contains a `sessions/` dir.
function looksLikeCodexHome(dir) {
  try { return fs.statSync(path.join(dir, 'sessions')).isDirectory(); } catch (_) { return false; }
}

function resolveCodexRoot() {
  const home = os.homedir();
  const explicit = argVal('--root', null);
  const candidates = [
    explicit && { dir: expandHome(explicit), src: 'given' },
    process.env.CODEX_HOME && { dir: expandHome(process.env.CODEX_HOME), src: '$CODEX_HOME' },
    process.env.XDG_CONFIG_HOME && { dir: path.join(expandHome(process.env.XDG_CONFIG_HOME), 'codex'), src: '$XDG_CONFIG_HOME/codex' },
    { dir: path.join(home, '.codex'), src: '~/.codex' },
    { dir: path.join(home, '.config', 'codex'), src: '~/.config/codex' },
    process.platform === 'darwin' && { dir: path.join(home, 'Library', 'Application Support', 'codex'), src: 'app support' },
    process.platform === 'win32' && process.env.APPDATA && { dir: path.join(process.env.APPDATA, 'codex'), src: '%APPDATA%' },
    process.platform === 'win32' && process.env.LOCALAPPDATA && { dir: path.join(process.env.LOCALAPPDATA, 'codex'), src: '%LOCALAPPDATA%' },
  ].filter(Boolean);

  for (const c of candidates) {
    if (looksLikeCodexHome(c.dir)) return { root: c.dir, why: c.src };
  }
  // fresh install: a dir that exists but has no sessions/ yet
  for (const c of candidates) {
    try { if (fs.statSync(c.dir).isDirectory()) return { root: c.dir, why: c.src + ' (no sessions yet)' }; } catch (_) {}
  }
  if (explicit) return { root: expandHome(explicit), why: 'given — not found!' };
  return { root: path.join(home, '.codex'), why: 'default — not found, is Codex installed?' };
}

const { root: CODEX_ROOT, why: ROOT_WHY } = resolveCodexRoot();
const SESSIONS_DIR = path.join(CODEX_ROOT, 'sessions');
const ARCHIVED_DIR = path.join(CODEX_ROOT, 'archived_sessions');
const SESSION_INDEX = path.join(CODEX_ROOT, 'session_index.jsonl');

// ---------------------------------------------------------------------------
// session_index.jsonl -> { id: thread_name }
// ---------------------------------------------------------------------------
let threadNames = {};
let threadNamesMtime = 0;
function loadThreadNames() {
  try {
    const st = fs.statSync(SESSION_INDEX);
    if (st.mtimeMs === threadNamesMtime) return;
    threadNamesMtime = st.mtimeMs;
    const out = {};
    for (const line of fs.readFileSync(SESSION_INDEX, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.id) out[o.id] = o.thread_name || null;
      } catch (_) {}
    }
    threadNames = out;
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// per-file incremental parser
// ---------------------------------------------------------------------------
// cache: filePath -> { offset, remainder, mtimeMs, size, summary }
const cache = new Map();

function fileUuid(filePath) {
  const m = path.basename(filePath).match(/rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  return m ? m[1] : path.basename(filePath);
}

function emptySummary(filePath) {
  return {
    file: filePath,
    id: fileUuid(filePath),
    parentId: null,
    depth: 0,
    agentNickname: null,
    isSubagent: false,
    cwd: null,
    project: null,
    git: null,
    originator: null,
    cliVersion: null,
    startedAt: null,
    lastEventAt: null,
    primaryModel: null,
    models: [],
    autoReview: false,
    effort: null,
    personality: null,
    serviceTier: null,
    contextWindow: null,
    tokens: null,          // total_token_usage object
    tokenSeries: [],       // [{t, total, last}]
    lastTotalTokens: 0,
    lastReqTokens: 0,
    lastReqInput: 0,
    messageCount: 0,
    userMessageCount: 0,
    toolCallCount: 0,
    turnsStarted: 0,
    turnsCompleted: 0,
    firstUserText: null,
    lastUserText: null,
    lastAssistantText: null,
    lastExec: null,        // {name, first, ts}
    commands: [],          // [{ts, name, cmd, total, last}] chronological
    taskActive: false,
  };
}

function isTagText(t) {
  return typeof t === 'string' && /^\s*<[a-zA-Z_]/.test(t.trim());
}

const unesc = (s) => s.replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();

// Codex tool inputs are usually JS snippets calling tools.exec_command({...}).
// Dig out the actual shell command; fall back to something readable.
function extractCmd(name, input) {
  if (!input) return name || '';
  if (/\*\*\*\s*Begin Patch/.test(input) || name === 'apply_patch') return 'apply_patch';
  // cmd: "…"  or  "cmd": "…"
  let m = input.match(/["']?cmd["']?\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) return unesc(m[1]);
  // cmd: `…` (template literal)
  m = input.match(/["']?cmd["']?\s*:\s*`([^`]*)`/);
  if (m) return unesc(m[1]);
  // cmd: ["bash","-lc","…"]  or  ["git","status"]
  m = input.match(/["']?cmd["']?\s*:\s*\[([^\]]*)\]/);
  if (m) {
    const parts = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => unesc(x[1]));
    if (parts.length) {
      if (/^(?:bash|sh|zsh)$/.test(parts[0]) && /^-[a-z]*c$/.test(parts[1] || '') && parts[2]) return parts[2];
      return parts.join(' ');
    }
  }
  // command: "…" (some tools)
  m = input.match(/["']?command["']?\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) return unesc(m[1]);
  // last resort: first non-empty, non-boilerplate line
  const line = input.split('\n').map((l) => l.trim())
    .find((l) => l && !/^(const|let|var|await|tools\.|text\(|return|\}|\/\/)/.test(l));
  return line || input.split('\n')[0].trim();
}

function textFromContent(content) {
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const c of content) {
    if (c && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.length ? parts.join('\n') : null;
}

function applyLine(sum, raw) {
  let o;
  try { o = JSON.parse(raw); } catch (_) { return; }
  const p = o.payload || {};
  const ts = o.timestamp || null;
  if (ts) sum.lastEventAt = ts;

  // --- session_meta (line 1) ---
  if (o.type === 'session_meta') {
    if (p.id) sum.id = p.id;
    sum.cwd = p.cwd || null;
    sum.project = p.cwd ? path.basename(p.cwd) : null;
    sum.originator = p.originator || null;
    sum.cliVersion = p.cli_version || null;
    sum.startedAt = p.timestamp || ts;
    if (p.git && typeof p.git === 'object') {
      sum.git = {
        branch: p.git.branch || null,
        repo: p.git.repository_url
          ? p.git.repository_url.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
          : null,
        commit: p.git.commit_hash ? p.git.commit_hash.slice(0, 8) : null,
      };
    }
    const src = p.source;
    if (src && typeof src === 'object' && src.subagent && src.subagent.thread_spawn) {
      const sp = src.subagent.thread_spawn;
      sum.isSubagent = true;
      sum.parentId = sp.parent_thread_id || p.parent_thread_id || null;
      sum.depth = sp.depth || 1;
      sum.agentNickname = sp.agent_nickname || null;
    } else if (p.parent_thread_id && p.parent_thread_id !== sum.id) {
      sum.parentId = p.parent_thread_id;
    }
    return;
  }

  // --- turn context: model / effort ---
  if (o.type === 'turn_context') {
    const m = p.model;
    if (m === 'codex-auto-review') {
      sum.autoReview = true;
    } else if (m) {
      sum.primaryModel = m;
      if (!sum.models.includes(m)) sum.models.push(m);
    }
    if (p.effort) sum.effort = p.effort;
    if (p.personality) sum.personality = p.personality;
    return;
  }

  if (o.type === 'event_msg' && p.type === 'thread_settings_applied') {
    const s = p.thread_settings || {};
    if (s.model && s.model !== 'codex-auto-review') {
      sum.primaryModel = sum.primaryModel || s.model;
      if (!sum.models.includes(s.model)) sum.models.push(s.model);
    }
    if (s.service_tier) sum.serviceTier = s.service_tier;
    return;
  }

  if (o.type === 'event_msg' && p.type === 'token_count') {
    const info = p.info || {};
    if (info.total_token_usage) {
      sum.tokens = info.total_token_usage;
      sum.lastTotalTokens = info.total_token_usage.total_tokens || 0;
      sum.lastReqTokens = (info.last_token_usage && info.last_token_usage.total_tokens) || 0;
      sum.lastReqInput = (info.last_token_usage && info.last_token_usage.input_tokens) || sum.lastReqInput;
      sum.tokenSeries.push({ t: ts, total: sum.lastTotalTokens, last: sum.lastReqTokens });
      if (sum.tokenSeries.length > 2000) sum.tokenSeries.shift();
    }
    if (info.model_context_window) sum.contextWindow = info.model_context_window;
    return;
  }

  if (o.type === 'event_msg' && p.type === 'task_started') { sum.turnsStarted++; sum.taskActive = true; return; }
  if (o.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_complete')) { sum.turnsCompleted++; sum.taskActive = false; return; }

  // --- response items ---
  if (o.type === 'response_item') {
    if (p.type === 'message') {
      sum.messageCount++;
      const txt = textFromContent(p.content);
      if (p.role === 'user') {
        sum.userMessageCount++;
        if (txt && !isTagText(txt)) {
          sum.lastUserText = txt.slice(0, 2000);
          if (!sum.firstUserText) sum.firstUserText = txt.slice(0, 2000);
        }
      } else if (p.role === 'assistant') {
        if (txt) sum.lastAssistantText = txt.slice(0, 600);
      }
      return;
    }
    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      sum.toolCallCount++;
      const input = typeof p.input === 'string' ? p.input : JSON.stringify(p.input || '');
      const entry = { ts, name: p.name || p.type, cmd: extractCmd(p.name, input).slice(0, 400),
        total: sum.lastTotalTokens, last: sum.lastReqTokens };
      sum.lastExec = { name: entry.name, first: entry.cmd, ts };
      sum.commands.push(entry);
      if (sum.commands.length > 300) sum.commands.shift();
      return;
    }
    if (p.type === 'agent_message') {
      const txt = textFromContent(p.content) || p.text;
      if (txt) sum.lastAssistantText = String(txt).slice(0, 600);
    }
  }
}

function refreshFile(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch (_) { cache.delete(filePath); return null; }
  let ent = cache.get(filePath);
  if (ent && ent.mtimeMs === st.mtimeMs && ent.size === st.size) {
    ent.summary.mtimeMs = st.mtimeMs;
    return ent.summary;
  }
  if (!ent || st.size < ent.offset) {
    ent = { offset: 0, remainder: '', summary: emptySummary(filePath) };
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const len = st.size - ent.offset;
    if (len > 0) {
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, ent.offset);
      const chunk = ent.remainder + buf.toString('utf8');
      const lines = chunk.split('\n');
      ent.remainder = lines.pop(); // trailing partial
      for (const line of lines) {
        if (line.trim()) applyLine(ent.summary, line);
      }
      ent.offset = st.size;
    }
  } finally {
    fs.closeSync(fd);
  }
  ent.mtimeMs = st.mtimeMs;
  ent.size = st.size;
  ent.summary.mtimeMs = st.mtimeMs;
  cache.set(filePath, ent);
  return ent.summary;
}

// ---------------------------------------------------------------------------
// directory discovery
// ---------------------------------------------------------------------------
function safeReaddir(d) {
  try { return fs.readdirSync(d); } catch (_) { return []; }
}

// returns array of "YYYY-MM-DD" that have a folder
function availableDates() {
  const dates = [];
  for (const y of safeReaddir(SESSIONS_DIR)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of safeReaddir(path.join(SESSIONS_DIR, y))) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of safeReaddir(path.join(SESSIONS_DIR, y, m))) {
        if (!/^\d{2}$/.test(d)) continue;
        dates.push(`${y}-${m}-${d}`);
      }
    }
  }
  dates.sort();
  dates.reverse();
  return dates;
}

function filesForDate(date) {
  const [y, m, d] = date.split('-');
  const dir = path.join(SESSIONS_DIR, y, m, d);
  return safeReaddir(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f));
}

function recentFiles(sinceMs) {
  // Session folders are dated by UTC; scan today + yesterday in BOTH the
  // local and UTC calendars so we never miss the current folder near midnight.
  const now = Date.now();
  const dates = new Set();
  for (let i = 0; i < 2; i++) {
    const dt = new Date(now - i * 86400000);
    dates.add(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`);
    dates.add(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`);
  }
  const out = [];
  for (const date of dates) {
    for (const fp of filesForDate(date)) {
      let st;
      try { st = fs.statSync(fp); } catch (_) { continue; }
      if (now - st.mtimeMs <= sinceMs) out.push({ fp, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// snapshot builders
// ---------------------------------------------------------------------------
// tools whose first arg is a sub-verb worth keeping in the "base command"
const MULTI_VERB = new Set([
  'git', 'cargo', 'npm', 'npx', 'pnpm', 'yarn', 'go', 'docker', 'kubectl', 'gh',
  'poetry', 'pip', 'uv', 'bundle', 'rake', 'make', 'terraform', 'aws', 'systemctl',
  'apt', 'apt-get', 'brew', 'rustup', 'deno', 'bun',
]);

function baseCommand(entry) {
  const name = entry.name || 'exec';
  if (name !== 'exec' && name !== 'shell' && name !== 'local_shell' && name !== 'container.exec') {
    return name;
  }
  let s = (entry.cmd || '').trim();
  if (!s) return name;
  // unwrap: leading "(cd path &&", "cd path &&", env VAR=val, "bash -lc '...'"
  s = s.replace(/^\(\s*/, '');
  s = s.replace(/^cd\s+\S+\s*&&\s*/, '');
  s = s.replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '');
  s = s.replace(/^(?:bash|sh|zsh)\s+-[a-z]*c\s+['"]/, '');
  // take up to first shell operator
  s = s.split(/\s*(?:\||&&|\|\||;|>|<)\s*/)[0].trim();
  const toks = s.split(/\s+/).filter(Boolean);
  if (!toks.length) return name;
  let w1 = toks[0].replace(/^['"]/, '');
  w1 = w1.split('/').pop(); // /usr/bin/git -> git
  if (MULTI_VERB.has(w1) && toks[1] && !toks[1].startsWith('-')) {
    return `${w1} ${toks[1].replace(/[^\w:-].*$/, '')}`;
  }
  return w1;
}

function buildCommands(sum) {
  let prev = null;
  const out = [];
  for (const e of sum.commands) {
    let delta = 0;
    if (prev != null && e.total >= prev) delta = e.total - prev;
    if (e.total > 0) prev = e.total;
    out.push({ ts: e.ts, name: e.name, cmd: e.cmd, base: baseCommand(e),
      total: e.total, last: e.last, delta });
  }
  return out;
}

function commandStats(cmds) {
  const m = new Map();
  for (const c of cmds) {
    const g = m.get(c.base) || { base: c.base, count: 0, tokens: 0, lastReq: 0, lastTs: null };
    g.count++;
    g.tokens += c.delta;
    g.lastReq += c.last || 0;
    if (!g.lastTs || c.ts > g.lastTs) g.lastTs = c.ts;
    m.set(c.base, g);
  }
  return [...m.values()].sort((a, b) => b.tokens - a.tokens || b.count - a.count);
}

function decorate(sum, full) {
  loadThreadNames();
  const age = Date.now() - (sum.mtimeMs || 0);
  const cmds = full ? buildCommands(sum) : null;
  return {
    id: sum.id,
    title: threadNames[sum.id] || null,
    parentId: sum.parentId,
    isSubagent: sum.isSubagent,
    depth: sum.depth,
    agentNickname: sum.agentNickname,
    project: sum.project,
    cwd: sum.cwd,
    git: sum.git,
    originator: sum.originator,
    cliVersion: sum.cliVersion,
    startedAt: sum.startedAt,
    lastEventAt: sum.lastEventAt,
    mtime: sum.mtimeMs,
    ageMs: age,
    status: age <= RUNNING_MS ? 'running' : age <= IDLE_MS ? 'idle' : 'stale',
    primaryModel: sum.primaryModel,
    models: sum.models,
    autoReview: sum.autoReview,
    effort: sum.effort,
    personality: sum.personality,
    serviceTier: sum.serviceTier,
    contextWindow: sum.contextWindow,
    tokens: sum.tokens,
    lastReqTokens: sum.lastReqTokens,
    lastReqInput: sum.lastReqInput,
    contextUsed: sum.contextWindow && sum.lastReqInput
      ? Math.min(100, Math.round(100 * sum.lastReqInput / sum.contextWindow)) : null,
    tokenSeries: full ? sum.tokenSeries.slice(-600) : sum.tokenSeries.slice(-60),
    messageCount: sum.messageCount,
    userMessageCount: sum.userMessageCount,
    toolCallCount: sum.toolCallCount,
    turnsStarted: sum.turnsStarted,
    turnsCompleted: sum.turnsCompleted,
    taskActive: sum.taskActive,
    firstUserText: sum.firstUserText,
    lastUserText: sum.lastUserText,
    lastAssistantText: sum.lastAssistantText,
    lastExec: sum.lastExec,
    commands: cmds ? cmds.slice(-150) : undefined,
    commandStats: cmds ? commandStats(cmds) : undefined,
  };
}

function liveSnapshot() {
  const rows = recentFiles(LIVE_WINDOW_MS)
    .map(({ fp }) => refreshFile(fp))
    .filter(Boolean)
    .map(decorate)
    .sort((a, b) => b.mtime - a.mtime);
  return { now: Date.now(), threads: rows };
}

function historySnapshot(date) {
  const rows = filesForDate(date)
    .map((fp) => refreshFile(fp))
    .filter(Boolean)
    .map(decorate)
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  return { date, threads: rows };
}

// full timeline for one session
function timeline(uuid) {
  // locate the file
  let found = null;
  for (const date of availableDates()) {
    for (const fp of filesForDate(date)) {
      if (fileUuid(fp) === uuid) { found = fp; break; }
    }
    if (found) break;
  }
  if (!found) {
    for (const f of safeReaddir(ARCHIVED_DIR)) {
      if (f.endsWith('.jsonl') && fileUuid(f) === uuid) { found = path.join(ARCHIVED_DIR, f); break; }
    }
  }
  if (!found) return null;

  const sum = emptySummary(found);
  const events = [];
  const raw = fs.readFileSync(found, 'utf8').split('\n');
  for (const line of raw) {
    if (!line.trim()) continue;
    applyLine(sum, line);
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    const p = o.payload || {};
    const ts = o.timestamp;
    if (o.type === 'response_item' && p.type === 'message') {
      const txt = textFromContent(p.content);
      if (txt && !isTagText(txt) && p.role !== 'developer' && p.role !== 'system')
        events.push({ ts, kind: 'message', role: p.role, text: txt.slice(0, 4000) });
    } else if (o.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
      const input = typeof p.input === 'string' ? p.input : JSON.stringify(p.input || '', null, 1);
      events.push({ ts, kind: 'tool', name: p.name || p.type, input: input.slice(0, 4000) });
    } else if (o.type === 'response_item' && p.type === 'reasoning' && Array.isArray(p.summary) && p.summary.length) {
      events.push({ ts, kind: 'reasoning', text: p.summary.join('\n').slice(0, 2000) });
    } else if (o.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.total_token_usage) {
      events.push({ ts, kind: 'tokens', total: p.info.total_token_usage.total_tokens });
    } else if (o.type === 'event_msg' && (p.type === 'task_started' || p.type === 'task_complete')) {
      events.push({ ts, kind: p.type });
    }
  }
  sum.mtimeMs = fs.statSync(found).mtimeMs;
  return { summary: decorate(sum, true), events };
}

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------
const sseClients = new Set();
function broadcast() {
  if (!sseClients.size) return;
  let payload;
  try { payload = JSON.stringify(liveSnapshot()); } catch (e) { return; }
  const frame = `data: ${payload}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch (_) {}
  }
}
setInterval(broadcast, TICK_MS);

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathn = url.pathname;

  if (pathn === '/' || pathn === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(INDEX_HTML);
    return;
  }

  if (pathn === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(liveSnapshot())}\n\n`);
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return;
  }

  if (pathn === '/api/dates') {
    return json(res, 200, { dates: availableDates() });
  }

  if (pathn === '/api/sessions') {
    const date = url.searchParams.get('date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'bad date' });
    return json(res, 200, historySnapshot(date));
  }

  if (pathn.startsWith('/api/session/')) {
    const uuid = decodeURIComponent(pathn.slice('/api/session/'.length));
    const t = timeline(uuid);
    if (!t) return json(res, 404, { error: 'not found' });
    return json(res, 200, t);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — codexmon may already be running.`);
    console.error(`open http://localhost:${PORT}, or start on another port:  node server.js --port 4318`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`codexmon → ${CODEX_ROOT}  [${ROOT_WHY}]`);
  if (!looksLikeCodexHome(CODEX_ROOT)) {
    console.warn(`  warning: no "sessions/" dir here. Set CODEX_HOME or pass --root /path/to/.codex`);
  }
  console.log(`  watching ${SESSIONS_DIR}`);
  console.log(`  http://localhost:${PORT}`);
});
