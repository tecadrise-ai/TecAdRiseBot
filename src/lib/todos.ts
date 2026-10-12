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
  const id = o.id != null && String(o.id).trim() ? String(o.id) : String(index + 1);
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

function statusRank(s: TodoStatus): number {
  if (s === 'completed') return 3;
  if (s === 'inProgress') return 2;
  if (s === 'cancelled') return 0;
  return 1;
}

function contentKey(text: string): string {
  return text.trim().toLowerCase();
}

export function mergeTodos(prev: TodoItem[], incoming: TodoItem[]): TodoItem[] {
  const byContent = new Map<string, TodoItem>();
  const order: string[] = [];
  const add = (t: TodoItem) => {
    const content = String(t.content || '').trim();
    if (!content) return;
    const key = contentKey(content);
    const cur = byContent.get(key);
    if (!cur) {
      byContent.set(key, { ...t, content });
      order.push(key);
      return;
    }
    const status = statusRank(t.status) >= statusRank(cur.status) ? t.status : cur.status;
    byContent.set(key, { ...cur, status, content: cur.content });
  };
  for (const t of prev) add(t);
  for (const t of incoming) add(t);
  return order.map((k) => byContent.get(k)!);
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

export function todosFromDelta(delta: unknown, depth = 0): TodoItem[] | null {
  if (!delta || depth > 8) return null;
  if (Array.isArray(delta)) {
    const direct = parseTodoList(delta);
    if (direct) return direct;
    for (const x of delta) {
      const found = todosFromDelta(x, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof delta !== 'object') return parseTodoList(delta);

  const rec = delta as Record<string, unknown>;
  const name = toolNameOf(rec);
  const args = argsOf(rec);
  if (isTodoTool(name)) {
    const list = parseTodoList(args) || parseTodoList((args as { todos?: unknown } | null)?.todos);
    if (list) return list;
  }
  if (Array.isArray(rec.todos)) {
    const list = parseTodoList(rec.todos);
    if (list) return list;
  }

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
  ]) {
    if (rec[key]) {
      const found = todosFromDelta(rec[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
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
