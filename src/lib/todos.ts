export type TodoStatus = 'pending' | 'inProgress' | 'completed' | 'cancelled';

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
};

export function normalizeTodoStatus(raw: unknown): TodoStatus {
  const v = String(raw || '')
    .toLowerCase()
    .replace(/[_-\s]/g, '');
  if (v === 'completed' || v === 'done' || v === 'complete') return 'completed';
  if (v === 'cancelled' || v === 'canceled' || v === 'skipped') return 'cancelled';
  if (v === 'inprogress' || v === 'doing' || v === 'running' || v === 'active') return 'inProgress';
  return 'pending';
}

function parseOne(raw: unknown, index: number): TodoItem | null {
  if (typeof raw === 'string') {
    const content = raw.trim();
    if (!content) return null;
    return { id: String(index + 1), content, status: 'pending' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const content = String(o.content || o.text || o.title || o.task || '').trim();
  if (!content) return null;
  const id = o.id != null && String(o.id).trim() ? String(o.id) : '';
  return { id, content, status: normalizeTodoStatus(o.status) };
}

export function parseTodoList(raw: unknown): TodoItem[] | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    try {
      return parseTodoList(JSON.parse(t));
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw)) {
    const hasObj = raw.some((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (!hasObj) return null;
    const list = raw.map(parseOne).filter((x): x is TodoItem => Boolean(x));
    return list.length ? list : null;
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.todos)) return parseTodoList(o.todos);
  }
  return null;
}

function contentKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^\d+[.)]\s*/, '');
}

function resolveIds(prev: TodoItem[], incoming: TodoItem[]): TodoItem[] {
  const used = new Set(prev.map((t) => t.id));
  const byKey = new Map(prev.map((t) => [contentKey(t.content), t.id]));
  let n = 0;
  return incoming.map((t) => {
    if (t.id) return t;
    const hit = byKey.get(contentKey(t.content));
    if (hit) return { ...t, id: hit };
    let id: string;
    do {
      id = `t${prev.length + ++n}`;
    } while (used.has(id));
    used.add(id);
    return { ...t, id };
  });
}

export function mergeTodos(prev: TodoItem[], incomingRaw: TodoItem[]): TodoItem[] {
  const incoming = resolveIds(prev, incomingRaw);
  const byId = new Map(prev.map((t) => [t.id, t]));
  for (const t of incoming) {
    const cur = byId.get(t.id);
    byId.set(t.id, cur ? { ...cur, ...t } : t);
  }
  const order = prev.map((t) => t.id);
  for (const t of incoming) {
    if (!order.includes(t.id)) order.push(t.id);
  }
  return order.map((id) => byId.get(id)!);
}

function withIds(list: TodoItem[]): TodoItem[] {
  const used = new Set(list.filter((t) => t.id).map((t) => t.id));
  let n = 0;
  return list.map((t) => {
    if (t.id) return t;
    let id: string;
    do {
      id = String(++n);
    } while (used.has(id));
    used.add(id);
    return { ...t, id };
  });
}

export function parseNumberedTasks(text: string): TodoItem[] {
  const out: TodoItem[] = [];
  const seen = new Set<string>();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\.\s+(.+?)\s*$/);
    if (!m) continue;
    const content = m[2].trim();
    if (!content || content.startsWith('#')) continue;
    const key = contentKey(content);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: m[1], content, status: 'pending' });
  }
  return out;
}

function jsonMaybe(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim();
  if (!t) return raw;
  try {
    return JSON.parse(t);
  } catch {
    return raw;
  }
}

function toolNameOf(rec: Record<string, unknown>): string {
  const fn = rec.function;
  const fnName =
    fn && typeof fn === 'object' && !Array.isArray(fn)
      ? String((fn as Record<string, unknown>).name || '')
      : '';
  return String(
    rec.name || rec.toolName || rec.tool || rec.functionName || fnName || rec.type || ''
  ).toLowerCase();
}

function argsOf(rec: Record<string, unknown>): unknown {
  const fn = rec.function;
  const fnArgs =
    fn && typeof fn === 'object' && !Array.isArray(fn)
      ? (fn as Record<string, unknown>).arguments
      : undefined;
  return jsonMaybe(rec.args ?? rec.arguments ?? rec.input ?? rec.params ?? fnArgs);
}

function isTodoTool(name: string): boolean {
  const n = String(name || '').toLowerCase().replace(/[_\s]/g, '');
  return n.includes('updatetodos') || n.includes('todowrite') || n === 'todo' || n === 'readtodos';
}

function mergeFlag(raw: unknown): boolean | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = (raw as { merge?: unknown }).merge;
  if (m === false || m === 0 || m === 'false') return false;
  if (m === true || m === 1 || m === 'true') return true;
  return null;
}

function resultOf(rec: Record<string, unknown>): unknown {
  return jsonMaybe(rec.result ?? rec.output ?? rec.toolResult ?? rec.tool_result);
}

function todoToolError(rec: Record<string, unknown>, result: unknown): string | undefined {
  const recErr = rec.error ?? rec.rejection ?? rec.rejectReason;
  if (typeof recErr === 'string' && recErr.trim()) return recErr.trim();
  if (recErr && typeof recErr === 'object') {
    const o = recErr as { message?: unknown; msg?: unknown };
    const msg = String(o.message || o.msg || '').trim();
    if (msg) return msg;
  }
  if (rec.isError === true || rec.rejected === true) {
    return 'Todo tool rejected this update.';
  }
  if (typeof result === 'string' && /invalid|rejected|enum|in_progress|inProgress/i.test(result)) {
    return result.trim();
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const o = result as Record<string, unknown>;
  if (o.success === false || o.ok === false) {
    const msg = String(o.error || o.message || o.reason || '').trim();
    return msg || 'Todo tool rejected this update.';
  }
  const nested = o.error ?? o.message;
  if (typeof nested === 'string' && /invalid|rejected|enum/i.test(nested)) return nested.trim();
  return undefined;
}

export type TodoCall = {
  todos: TodoItem[];
  merge: boolean | null;
  snapshot?: boolean;
  error?: string;
};

const RESULT_LINE = /^\s*-\s*\*\*(\w+)\*\*:\s*(.+?)\s*\(id:\s*([^)]+)\)\s*$/gm;

export function parseTodoResultText(text: unknown): TodoItem[] | null {
  if (typeof text !== 'string' || !text.includes('(id:')) return null;
  const out: TodoItem[] = [];
  RESULT_LINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RESULT_LINE.exec(text))) {
    out.push({ id: m[3].trim(), content: m[2].trim(), status: normalizeTodoStatus(m[1]) });
  }
  return out.length ? out : null;
}

export function applyTodoCallToList(cur: TodoItem[], call: TodoCall): TodoItem[] {
  if (!call.todos.length) return cur;
  const incoming = resolveIds(cur, call.todos);
  if (call.snapshot && cur.length) {
    // tool result groups items by status, keep the order the list already had
    const byId = new Map(incoming.map((t) => [t.id, t]));
    const byKey = new Map(incoming.map((t) => [contentKey(t.content), t]));
    const out: TodoItem[] = [];
    const seen = new Set<TodoItem>();
    for (const c of cur) {
      const hit = byId.get(c.id) || byKey.get(contentKey(c.content));
      if (hit && !seen.has(hit)) {
        seen.add(hit);
        out.push({ ...hit, id: c.id });
      }
    }
    for (const t of incoming) if (!seen.has(t)) out.push(t);
    return out;
  }
  const ids = new Set(cur.map((t) => t.id));
  const keys = new Set(cur.map((t) => contentKey(t.content)));
  const subset =
    incoming.every((t) => ids.has(t.id) || keys.has(contentKey(t.content))) &&
    incoming.length < cur.length;
  const doMerge = call.merge === true || (call.merge === null && subset);
  return doMerge ? mergeTodos(cur, incoming) : withIds(call.todos);
}

function callFromRecord(rec: Record<string, unknown>): TodoCall | null {
  const name = toolNameOf(rec);
  const args = argsOf(rec);
  const result = resultOf(rec);
  const argList =
    parseTodoList(args) || parseTodoList((args as { todos?: unknown } | null)?.todos);
  const resultObj = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : null;
  const resultList =
    parseTodoList(resultObj?.final_todos) ||
    parseTodoList(resultObj?.finalTodos) ||
    parseTodoResultText(result) ||
    parseTodoResultText(resultObj?.text) ||
    parseTodoResultText(resultObj?.content) ||
    parseTodoList(result);
  const error = isTodoTool(name) ? todoToolError(rec, result) : undefined;
  const mergeArg = mergeFlag(args) ?? mergeFlag(rec);
  const wasMerge = resultObj?.was_merge === true || resultObj?.wasMerge === true;
  const merge: boolean | null = mergeArg === true || wasMerge ? true : mergeArg === false ? false : null;
  if (resultList && resultList.length >= (argList?.length || 0)) {
    return { todos: resultList, merge: false, snapshot: true, error };
  }
  const todos = argList || resultList || (Array.isArray(rec.todos) ? parseTodoList(rec.todos) : null);
  if (!todos?.length && !error) return null;
  if (!isTodoTool(name) && !todos?.length) return null;
  return { todos: todos || [], merge, error };
}

export function todoCallFromDelta(delta: unknown, depth = 0): TodoCall | null {
  if (!delta || depth > 8) return null;
  if (Array.isArray(delta)) {
    let last: TodoCall | null = null;
    const direct = parseTodoList(delta);
    if (direct) last = { todos: direct, merge: false };
    for (const x of delta) {
      const found = todoCallFromDelta(x, depth + 1);
      if (found) last = found;
    }
    return last;
  }
  if (typeof delta !== 'object') {
    const list = parseTodoList(delta);
    return list ? { todos: list, merge: false } : null;
  }

  const rec = delta as Record<string, unknown>;
  let last = callFromRecord(rec);

  for (const key of [
    'update',
    'toolCall',
    'tool_call',
    'call',
    'delta',
    'item',
    'result',
    'steps',
    'message',
    'messages',
  ]) {
    if (rec[key]) {
      const found = todoCallFromDelta(rec[key], depth + 1);
      if (found) last = found;
    }
  }
  return last;
}

export function todosFromDelta(delta: unknown, depth = 0): TodoItem[] | null {
  const call = todoCallFromDelta(delta, depth);
  return call?.todos.length ? call.todos : null;
}

export function parseMessageTodos(meta: string | null | undefined): TodoItem[] {
  if (!meta) return [];
  try {
    const o = JSON.parse(meta) as { todos?: unknown };
    return parseTodoList(o?.todos) || [];
  } catch {
    return [];
  }
}
