import { BrowserWindow } from 'electron';
import { CronExpressionParser } from 'cron-parser';
import * as db from './db';
import { runAgentTurn } from './agentRunner';

let timer: NodeJS.Timeout | null = null;
let winRef: BrowserWindow | null = null;

export function startScheduler(getWin: () => BrowserWindow | null): void {
  winRef = getWin();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    winRef = getWin();
    tick().catch((e) => console.error('scheduler tick', e));
  }, 5_000);
  setTimeout(() => tick().catch(() => undefined), 2000);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function unitMs(unit: string, n: number): number {
  const v = Math.max(1, n);
  if (unit === 's') return v * 1000;
  if (unit === 'm') return v * 60_000;
  if (unit === 'h') return v * 3_600_000;
  if (unit === 'd') return v * 86_400_000;
  return v * 60_000;
}

function parseInterval(raw: string): { ms: number; loop: boolean } | null {
  const s = raw.trim();
  if (s.startsWith('loop:')) {
    const v = s.slice(5);
    const unit = v.slice(-1);
    const n = parseInt(v.slice(0, -1), 10);
    if (!n || !['s', 'm', 'h', 'd'].includes(unit)) return null;
    return { ms: unitMs(unit, n), loop: true };
  }
  if (/^\d+[smhd]$/.test(s)) {
    const unit = s.slice(-1);
    const n = parseInt(s.slice(0, -1), 10);
    return { ms: unitMs(unit, n), loop: true };
  }
  if (s.startsWith('interval:')) {
    const v = s.slice(9);
    const unit = v.slice(-1);
    const n = parseInt(v.slice(0, -1), 10);
    if (!n || !['s', 'm', 'h', 'd'].includes(unit)) return null;
    return { ms: unitMs(unit, n), loop: false };
  }
  return null;
}

function cronExpr(stored: string): string | null {
  const s = stored.trim();
  if (s.startsWith('cron:')) return s.slice(5).trim();
  if (/^[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+$/.test(s)) return s;
  return null;
}

function onceAt(stored: string): number | null {
  if (!stored.startsWith('date:')) return null;
  const raw = stored.slice(5).trim().replace(' ', 'T');
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

async function fire(r: db.RoutineRow, now: number): Promise<void> {
  db.updateRoutine(r.id, { lastRunAt: now });
  const prompt = `[Scheduled routine: ${r.name}]\n\n${r.prompt}`;
  await runAgentTurn({
    agentId: r.agentId,
    userText: prompt,
    win: winRef,
    source: 'routine',
  });
  winRef?.webContents.send('routines:fired', { routineId: r.id, at: now });
}

async function tick(): Promise<void> {
  const now = Date.now();
  const routines = db.listRoutines().filter((r) => Number(r.enabled) !== 0);
  for (const r of routines) {
    try {
      const stored = (r.cron || '').trim();
      const interval = parseInterval(stored);
      if (interval) {
        const last = r.lastRunAt ?? 0;
        if (!last) {
          if (interval.loop) {
            await fire(r, now);
          } else if (now - (r.createdAt || now) >= interval.ms) {
            await fire(r, now);
          }
        } else if (now - last >= interval.ms) {
          await fire(r, now);
        }
        continue;
      }

      const at = onceAt(stored);
      if (at !== null) {
        if (now >= at && !(r.lastRunAt && r.lastRunAt >= at)) {
          await fire(r, now);
          db.updateRoutine(r.id, { enabled: 0 });
        }
        continue;
      }

      const exprStr = cronExpr(stored);
      if (!exprStr) continue;
      const expr = CronExpressionParser.parse(exprStr, { currentDate: new Date(now) });
      const prev = expr.prev().getTime();
      const last = r.lastRunAt ?? 0;
      if (prev > last && now - prev < 120_000) {
        await fire(r, now);
      }
    } catch (e) {
      console.error('routine check failed', r.id, e);
    }
  }
}
