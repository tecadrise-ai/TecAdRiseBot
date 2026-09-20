import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { AGENT_BADGE_COLORS } from '../src/lib/agentColors';
import { DEFAULT_AGENT_SOUL } from '../src/lib/soul';
import { parseMessageUsage } from '../src/lib/usage';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let dbPath = '';

const AVATAR_COLORS = AGENT_BADGE_COLORS;

export type AgentRow = {
  id: string;
  name: string;
  color: string;
  model: string;
  cursorAgentId: string | null;
  lastSnippet: string | null;
  instructions: string | null;
  config: Record<string, unknown> | null;
  enabled: number;
  createdAt: number;
  updatedAt: number;
};

export type MessageRow = {
  id: string;
  agentId: string;
  role: 'user' | 'assistant' | 'system' | 'interbot';
  content: string;
  meta: string | null;
  createdAt: number;
};

export type RoutineRow = {
  id: string;
  agentId: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: number;
  forceTodos: number;
  lastRunAt: number | null;
  createdAt: number;
};

function persist() {
  if (!db || !dbPath) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function wasmDir(): string {
  try {
    const pkg = path.dirname(require.resolve('sql.js/package.json'));
    return path.join(pkg, 'dist');
  } catch {
    return path.join(process.cwd(), 'node_modules', 'sql.js', 'dist');
  }
}

function tableColumns(table: string): Set<string> {
  const stmt = mustDb().prepare(`PRAGMA table_info(${table})`);
  const cols = new Set<string>();
  while (stmt.step()) {
    const r = stmt.getAsObject();
    cols.add(String(r.name));
  }
  stmt.free();
  return cols;
}

function migrateAgentsSchema(): void {
  const cols = tableColumns('agents');
  if (!cols.has('instructions')) {
    mustDb().run(`ALTER TABLE agents ADD COLUMN instructions TEXT`);
  }
  if (!cols.has('config_json')) {
    mustDb().run(`ALTER TABLE agents ADD COLUMN config_json TEXT`);
  }
  if (!cols.has('enabled')) {
    mustDb().run(`ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`);
  }
  if (!cols.has('sort_order')) {
    mustDb().run(`ALTER TABLE agents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
    const stmt = mustDb().prepare(`SELECT id FROM agents ORDER BY updated_at DESC`);
    const ids: string[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, unknown>;
      ids.push(String(r.id));
    }
    stmt.free();
    ids.forEach((id, i) => {
      mustDb().run(`UPDATE agents SET sort_order=? WHERE id=?`, [i, id]);
    });
  }
}

function migrateRoutinesSchema(): void {
  const cols = tableColumns('routines');
  if (!cols.has('force_todos')) {
    mustDb().run(`ALTER TABLE routines ADD COLUMN force_todos INTEGER NOT NULL DEFAULT 0`);
  }
}

function parseConfig(raw: unknown): Record<string, unknown> | null {
  if (raw == null || raw === '') return null;
  try {
    const v = JSON.parse(String(raw));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return { value: v };
  } catch {
    return null;
  }
}

function mapAgentRow(r: Record<string, unknown>): AgentRow {
  return {
    id: String(r.id),
    name: String(r.name),
    color: String(r.color),
    model: String(r.model),
    cursorAgentId: r.cursor_agent_id != null ? String(r.cursor_agent_id) : null,
    lastSnippet: r.last_snippet != null ? String(r.last_snippet) : null,
    instructions: r.instructions != null ? String(r.instructions) : null,
    config: parseConfig(r.config_json),
    enabled: r.enabled == null ? 1 : Number(r.enabled),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export async function initDb(userDataPath?: string): Promise<void> {
  const base = userDataPath ?? app.getPath('userData');
  fs.mkdirSync(base, { recursive: true });
  dbPath = path.join(base, 'tecadrisebot.db');

  SQL = await initSqlJs({
    locateFile: (file) => path.join(wasmDir(), file),
  });

  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'composer-2.5',
      cursor_agent_id TEXT,
      last_snippet TEXT,
      instructions TEXT,
      config_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cron TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      created_at INTEGER NOT NULL,
      force_todos INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, created_at);
  `);
  migrateAgentsSchema();
  migrateRoutinesSchema();
  persist();
  ensureMemoryDir(base);
  ensureSkillsDir(base);
  void __dirname;
}

function mustDb(): Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function previewSnippet(text: string): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function lastContentSnippet(agentId: string): string | null {
  const stmt = mustDb().prepare(
    `SELECT content FROM messages WHERE agent_id=$aid AND TRIM(content) != '' ORDER BY created_at DESC LIMIT 1`
  );
  stmt.bind({ $aid: agentId });
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const snippet = previewSnippet(String(stmt.getAsObject().content ?? ''));
  stmt.free();
  return snippet || null;
}

function nextSortOrder(): number {
  const stmt = mustDb().prepare(`SELECT MAX(sort_order) AS m FROM agents`);
  let m = -1;
  if (stmt.step()) {
    const r = stmt.getAsObject() as Record<string, unknown>;
    if (r.m != null && Number.isFinite(Number(r.m))) m = Number(r.m);
  }
  stmt.free();
  return m + 1;
}

export function listAgents(): AgentRow[] {
  const stmt = mustDb().prepare(
    `SELECT id, name, color, model, cursor_agent_id, last_snippet, instructions, config_json, enabled, created_at, updated_at
     FROM agents ORDER BY sort_order ASC, created_at ASC`
  );
  const rows: AgentRow[] = [];
  while (stmt.step()) {
    rows.push(mapAgentRow(stmt.getAsObject() as Record<string, unknown>));
  }
  stmt.free();
  for (const row of rows) {
    if (!row.lastSnippet) row.lastSnippet = lastContentSnippet(row.id);
  }
  return rows;
}

export function getAgent(id: string): AgentRow | null {
  const stmt = mustDb().prepare(
    `SELECT id, name, color, model, cursor_agent_id, last_snippet, instructions, config_json, enabled, created_at, updated_at
     FROM agents WHERE id=$id`
  );
  stmt.bind({ $id: id });
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = mapAgentRow(stmt.getAsObject() as Record<string, unknown>);
  stmt.free();
  return row;
}

export function createAgent(input: {
  id: string;
  name: string;
  model?: string;
  instructions?: string | null;
  config?: Record<string, unknown> | null;
  enabled?: number;
}): AgentRow {
  const now = Date.now();
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const model = input.model ?? 'composer-2.5';
  const instructions = input.instructions ?? DEFAULT_AGENT_SOUL;
  const configJson = input.config != null ? JSON.stringify(input.config) : null;
  const enabled = input.enabled ?? 1;
  const sortOrder = nextSortOrder();
  mustDb().run(
    `INSERT INTO agents (id, name, color, model, cursor_agent_id, last_snippet, instructions, config_json, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.name, color, model, instructions, configJson, enabled, sortOrder, now, now]
  );
  persist();
  return getAgent(input.id)!;
}

export function updateAgent(
  id: string,
  patch: Partial<{
    name: string;
    color: string;
    model: string;
    cursorAgentId: string | null;
    lastSnippet: string | null;
    instructions: string | null;
    config: Record<string, unknown> | null;
    enabled: number;
  }>
): AgentRow | null {
  const existing = getAgent(id);
  if (!existing) return null;
  const name = patch.name ?? existing.name;
  const color = patch.color ?? existing.color;
  const model = patch.model ?? existing.model;
  const cursorAgentId = patch.cursorAgentId !== undefined ? patch.cursorAgentId : existing.cursorAgentId;
  const lastSnippet = patch.lastSnippet !== undefined ? patch.lastSnippet : existing.lastSnippet;
  const instructions = patch.instructions !== undefined ? patch.instructions : existing.instructions;
  const config = patch.config !== undefined ? patch.config : existing.config;
  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
  const now = Date.now();
  mustDb().run(
    `UPDATE agents SET name=?, color=?, model=?, cursor_agent_id=?, last_snippet=?, instructions=?, config_json=?, enabled=?, updated_at=? WHERE id=?`,
    [
      name,
      color,
      model,
      cursorAgentId,
      lastSnippet,
      instructions,
      config != null ? JSON.stringify(config) : null,
      enabled,
      now,
      id,
    ]
  );
  persist();
  return getAgent(id);
}

export function reorderAgents(orderedIds: string[]): AgentRow[] {
  const current = listAgents();
  const known = new Set(current.map((a) => a.id));
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of orderedIds) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  for (const a of current) {
    if (!seen.has(a.id)) next.push(a.id);
  }
  const d = mustDb();
  next.forEach((id, i) => {
    d.run(`UPDATE agents SET sort_order=? WHERE id=?`, [i, id]);
  });
  persist();
  return listAgents();
}

export function deleteAgent(id: string): void {
  mustDb().run(`DELETE FROM messages WHERE agent_id=?`, [id]);
  mustDb().run(`DELETE FROM routines WHERE agent_id=?`, [id]);
  mustDb().run(`DELETE FROM agents WHERE id=?`, [id]);
  persist();
}

export function listMessages(
  agentId: string,
  opts?: { limit?: number; before?: number }
): MessageRow[] {
  const limit = opts?.limit ?? 500;
  const before = opts?.before;
  let sql = `SELECT id, agent_id, role, content, meta, created_at FROM messages WHERE agent_id=$aid`;
  const bind: Record<string, string | number> = { $aid: agentId, $lim: limit };
  if (before != null) {
    sql += ` AND created_at < $before`;
    bind.$before = before;
  }
  sql += ` ORDER BY created_at DESC LIMIT $lim`;
  const stmt = mustDb().prepare(sql);
  stmt.bind(bind);
  const rows: MessageRow[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      id: String(r.id),
      agentId: String(r.agent_id),
      role: r.role as MessageRow['role'],
      content: String(r.content),
      meta: r.meta != null ? String(r.meta) : null,
      createdAt: Number(r.created_at),
    });
  }
  stmt.free();
  // Return chronological (oldest → newest) for chat UIs
  return rows.reverse();
}

export function getMessage(id: string): MessageRow | null {
  const stmt = mustDb().prepare(
    `SELECT id, agent_id, role, content, meta, created_at FROM messages WHERE id=$id`
  );
  stmt.bind({ $id: id });
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const r = stmt.getAsObject();
  stmt.free();
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    role: r.role as MessageRow['role'],
    content: String(r.content),
    meta: r.meta != null ? String(r.meta) : null,
    createdAt: Number(r.created_at),
  };
}

export function addMessage(msg: Omit<MessageRow, 'createdAt'> & { createdAt?: number }): MessageRow {
  const createdAt = msg.createdAt ?? Date.now();
  mustDb().run(
    `INSERT INTO messages (id, agent_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.agentId, msg.role, msg.content, msg.meta, createdAt]
  );
  const snippet = previewSnippet(msg.content);
  if (snippet) {
    mustDb().run(`UPDATE agents SET last_snippet=?, updated_at=? WHERE id=?`, [snippet, createdAt, msg.agentId]);
  }
  persist();
  return { ...msg, createdAt };
}

export function updateMessageContent(id: string, content: string): void {
  mustDb().run(`UPDATE messages SET content=? WHERE id=?`, [content, id]);
  const msg = getMessage(id);
  const snippet = msg ? previewSnippet(msg.content) : '';
  if (msg && snippet) {
    mustDb().run(`UPDATE agents SET last_snippet=?, updated_at=? WHERE id=?`, [
      snippet,
      Date.now(),
      msg.agentId,
    ]);
  }
  persist();
}

export function patchMessageMeta(id: string, patch: Record<string, unknown>): void {
  const msg = getMessage(id);
  if (!msg) return;
  let cur: Record<string, unknown> = {};
  if (msg.meta) {
    try {
      const parsed = JSON.parse(msg.meta);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cur = parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
  }
  mustDb().run(`UPDATE messages SET meta=? WHERE id=?`, [JSON.stringify({ ...cur, ...patch }), id]);
  persist();
}

export function formatRoutineUserText(r: { name: string; prompt: string; forceTodos?: number }): string {
  const body = `[Scheduled routine: ${r.name}]\n\n${r.prompt}`;
  if (!r.forceTodos) return body;
  return (
    body +
    '\n\n# Mode: FORCE updateTodos\n' +
    'You MUST call the updateTodos tool with these routine steps as a checklist, then execute them in order, one step at a time. Do not skip updateTodos. If a step fails, stop and explain.\n'
  );
}

export function listRoutines(agentId?: string): RoutineRow[] {
  let sql = `SELECT id, agent_id, name, cron, prompt, enabled, force_todos, last_run_at, created_at FROM routines`;
  if (agentId) sql += ` WHERE agent_id=$aid`;
  sql += ` ORDER BY created_at DESC`;
  const stmt = mustDb().prepare(sql);
  if (agentId) stmt.bind({ $aid: agentId });
  const rows: RoutineRow[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      id: String(r.id),
      agentId: String(r.agent_id),
      name: String(r.name),
      cron: String(r.cron),
      prompt: String(r.prompt),
      enabled: Number(r.enabled),
      forceTodos: r.force_todos == null ? 0 : Number(r.force_todos),
      lastRunAt: r.last_run_at != null ? Number(r.last_run_at) : null,
      createdAt: Number(r.created_at),
    });
  }
  stmt.free();
  return rows;
}

export function getRoutine(id: string): RoutineRow | null {
  return listRoutines().find((r) => r.id === id) ?? null;
}

export function createRoutine(input: {
  id: string;
  agentId: string;
  name: string;
  cron: string;
  prompt: string;
  enabled?: number;
  forceTodos?: number;
}): RoutineRow {
  const now = Date.now();
  const enabled = input.enabled ?? 1;
  const forceTodos = input.forceTodos ? 1 : 0;
  mustDb().run(
    `INSERT INTO routines (id, agent_id, name, cron, prompt, enabled, force_todos, last_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [input.id, input.agentId, input.name, input.cron, input.prompt, enabled, forceTodos, now]
  );
  persist();
  return getRoutine(input.id)!;
}

export function updateRoutine(
  id: string,
  patch: Partial<{
    name: string;
    cron: string;
    prompt: string;
    enabled: number;
    forceTodos: number;
    lastRunAt: number | null;
  }>
): RoutineRow | null {
  const existing = getRoutine(id);
  if (!existing) return null;
  mustDb().run(
    `UPDATE routines SET name=?, cron=?, prompt=?, enabled=?, force_todos=?, last_run_at=? WHERE id=?`,
    [
      patch.name ?? existing.name,
      patch.cron ?? existing.cron,
      patch.prompt ?? existing.prompt,
      patch.enabled ?? existing.enabled,
      patch.forceTodos !== undefined ? (patch.forceTodos ? 1 : 0) : existing.forceTodos,
      patch.lastRunAt !== undefined ? patch.lastRunAt : existing.lastRunAt,
      id,
    ]
  );
  persist();
  return getRoutine(id);
}

export function deleteRoutine(id: string): void {
  mustDb().run(`DELETE FROM routines WHERE id=?`, [id]);
  persist();
}

export function getSetting(key: string): string | null {
  const stmt = mustDb().prepare(`SELECT value FROM settings WHERE key=$k`);
  stmt.bind({ $k: key });
  if (stmt.step()) {
    const v = String(stmt.getAsObject().value);
    stmt.free();
    return v;
  }
  stmt.free();
  return null;
}

export function setSetting(key: string, value: string): void {
  mustDb().run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
  persist();
}

export function ensureWorkspacesDir(userDataPath?: string): string {
  const base = userDataPath ?? app.getPath('userData');
  const dir = path.join(base, 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureMemoryDir(userDataPath?: string): string {
  const base = userDataPath ?? app.getPath('userData');
  const dir = path.join(base, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(dir, 'index.md');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(
      indexPath,
      '# Memory index\n\nShared host memory for all TecAdRiseBot agents. Start here.\n\n- People: (empty)\n- Preferences: (empty)\n- Decisions: (empty)\n',
      'utf8'
    );
  }
  const logPath = path.join(dir, 'log.md');
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '# Memory log\n\n', 'utf8');
  }
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  return dir;
}

export function ensureSkillsDir(userDataPath?: string): string {
  const base = userDataPath ?? app.getPath('userData');
  const dir = path.join(base, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      '# Skills\n\nOne subfolder per skill. Required file: SKILL.md\n\nExample: skills/seo/SKILL.md\n\nAll agents see a catalog of these folders every turn. When the user says to use a named skill, the agent should read that SKILL.md and follow it.\n',
      'utf8'
    );
  }
  return dir;
}

function skillBlurb(text: string): string {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (d) return d[1].replace(/^["']|["']$/g, '').trim().slice(0, 160);
  }
  const line = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith('#') && s !== '---');
  return (line || 'Skill').slice(0, 160);
}

export function formatSkillsCatalog(): string {
  const root = ensureSkillsDir();
  const lines: string[] = [
    `Root: ${root}`,
    'When the user names a skill (for example "use seo skill"), open that subfolder and read SKILL.md first, then follow it. Do not invent a skill that is not listed. If none match, say so.',
  ];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const skills: string[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const skillFile = path.join(root, ent.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    let body = '';
    try {
      body = fs.readFileSync(skillFile, 'utf8');
    } catch {
      body = '';
    }
    skills.push(`- ${ent.name}: ${skillBlurb(body)} | ${skillFile}`);
  }
  if (!skills.length) {
    lines.push('No skill folders yet. Add a subfolder with SKILL.md inside this root.');
  } else {
    lines.push(...skills);
  }
  return lines.join('\n');
}

export function agentWorkspacePath(agentId: string, userDataPath?: string): string {
  const dir = path.join(ensureWorkspacesDir(userDataPath), agentId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export type AgentUsageRow = {
  agentId: string;
  name: string;
  color: string;
  replies: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
};

export function listAgentUsage(): AgentUsageRow[] {
  const agents = listAgents();
  const rows = new Map<string, AgentUsageRow>();
  for (const a of agents) {
    rows.set(a.id, {
      agentId: a.id,
      name: a.name,
      color: a.color,
      replies: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
    });
  }
  const stmt = mustDb().prepare(
    `SELECT agent_id, meta FROM messages WHERE role='assistant' AND meta IS NOT NULL`
  );
  while (stmt.step()) {
    const r = stmt.getAsObject();
    const id = String(r.agent_id);
    const row = rows.get(id);
    if (!row) continue;
    const u = parseMessageUsage(r.meta != null ? String(r.meta) : null);
    if (!u) continue;
    row.replies += 1;
    row.inputTokens += Number(u.inputTokens) || 0;
    row.outputTokens += Number(u.outputTokens) || 0;
    row.cacheReadTokens += Number(u.cacheReadTokens) || 0;
    const piece =
      Number(u.totalTokens) ||
      (Number(u.inputTokens) || 0) +
        (Number(u.outputTokens) || 0) +
        (Number(u.cacheReadTokens) || 0) +
        (Number(u.cacheWriteTokens) || 0);
    row.totalTokens += piece;
  }
  stmt.free();
  return Array.from(rows.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}
