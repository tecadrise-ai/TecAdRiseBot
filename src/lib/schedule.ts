/** Agent-OS–compatible schedule (same Trigger UI as tecadrise-agent-os). */

export type ScheduleKind = 'loop' | 'interval' | 'daily' | 'weekly' | 'once' | 'cron';

export type ScheduleDraft = {
  kind: ScheduleKind;
  every: number;
  unit: 's' | 'm' | 'h' | 'd';
  time: string; // HH:MM
  weekday: number; // 0=Sun .. 6=Sat
  datetime: string; // YYYY-MM-DDTHH:MM for datetime-local
  cronExpr: string;
};

export const DEFAULT_SCHEDULE: ScheduleDraft = {
  kind: 'interval',
  every: 15,
  unit: 'm',
  time: '08:30',
  weekday: 1,
  datetime: '',
  cronExpr: '',
};

export const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];

export const UNITS: { value: ScheduleDraft['unit']; label: string }[] = [
  { value: 's', label: 'Seconds' },
  { value: 'm', label: 'Minutes' },
  { value: 'h', label: 'Hours' },
  { value: 'd', label: 'Days' },
];

export const KINDS: { id: ScheduleKind; label: string }[] = [
  { id: 'loop', label: 'Loop (repeat with delay)' },
  { id: 'interval', label: 'Interval (every X time)' },
  { id: 'daily', label: 'Daily (specific time)' },
  { id: 'weekly', label: 'Weekly (day and time)' },
  { id: 'once', label: 'Once (date and time)' },
  { id: 'cron', label: 'Custom cron' },
];

/** Encode to agent-os trigger value string (stored in routines.cron). */
export function encodeSchedule(d: ScheduleDraft): string {
  if (d.kind === 'loop') return `loop:${d.every || 60}${d.unit}`;
  if (d.kind === 'interval') return `interval:${d.every || 15}${d.unit}`;
  if (d.kind === 'daily') {
    const [hh, mm] = (d.time || '08:30').split(':');
    return `cron:${parseInt(mm, 10)} ${parseInt(hh, 10)} * * *`;
  }
  if (d.kind === 'weekly') {
    const [hh, mm] = (d.time || '09:00').split(':');
    return `cron:${parseInt(mm, 10)} ${parseInt(hh, 10)} * * ${d.weekday}`;
  }
  if (d.kind === 'once') {
    const raw = d.datetime || '';
    if (!raw) return '';
    return `date:${raw.replace('T', ' ')}:00`;
  }
  return `cron:${(d.cronExpr || '* * * * *').trim()}`;
}

export function decodeSchedule(stored: string): ScheduleDraft {
  const s = (stored || '').trim();
  const base = { ...DEFAULT_SCHEDULE };

  if (s.startsWith('loop:')) {
    const v = s.slice(5);
    const unit = v.slice(-1) as ScheduleDraft['unit'];
    const every = parseInt(v.slice(0, -1), 10) || 60;
    return { ...base, kind: 'loop', every, unit: ['s', 'm', 'h', 'd'].includes(unit) ? unit : 's' };
  }
  if (/^\d+[smhd]$/.test(s)) {
    const unit = s.slice(-1) as ScheduleDraft['unit'];
    const every = parseInt(s.slice(0, -1), 10) || 60;
    return { ...base, kind: 'loop', every, unit };
  }
  if (s.startsWith('interval:')) {
    const v = s.slice(9);
    const unit = v.slice(-1) as ScheduleDraft['unit'];
    const every = parseInt(v.slice(0, -1), 10) || 15;
    return { ...base, kind: 'interval', every, unit: ['s', 'm', 'h', 'd'].includes(unit) ? unit : 'm' };
  }
  if (s.startsWith('date:')) {
    const raw = s.slice(5).trim().replace(' ', 'T');
    return { ...base, kind: 'once', datetime: raw.length >= 16 ? raw.slice(0, 16) : raw };
  }
  if (s.startsWith('cron:')) {
    const cron = s.slice(5).trim();
    const p = cron.split(/\s+/);
    if (p.length === 5 && p[2] === '*' && p[3] === '*' && p[4] === '*') {
      return {
        ...base,
        kind: 'daily',
        time: `${p[1].padStart(2, '0')}:${p[0].padStart(2, '0')}`,
      };
    }
    if (p.length === 5 && p[2] === '*' && p[3] === '*' && p[4] !== '*') {
      return {
        ...base,
        kind: 'weekly',
        time: `${p[1].padStart(2, '0')}:${p[0].padStart(2, '0')}`,
        weekday: parseInt(p[4], 10),
      };
    }
    return { ...base, kind: 'cron', cronExpr: cron };
  }
  // legacy plain 5-field cron
  if (/^[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+$/.test(s)) {
    return decodeSchedule(`cron:${s}`);
  }
  return base;
}

export function describeSchedule(stored: string): string {
  const d = decodeSchedule(stored);
  const unitWord: Record<string, string> = {
    s: d.every === 1 ? 'second' : 'seconds',
    m: d.every === 1 ? 'minute' : 'minutes',
    h: d.every === 1 ? 'hour' : 'hours',
    d: d.every === 1 ? 'day' : 'days',
  };
  if (d.kind === 'loop') return `Loop every ${d.every} ${unitWord[d.unit]}`;
  if (d.kind === 'interval') return `Every ${d.every} ${unitWord[d.unit]}`;
  if (d.kind === 'daily') return `Daily at ${d.time}`;
  if (d.kind === 'weekly') {
    const day = WEEKDAYS.find((w) => w.value === d.weekday)?.label ?? `day ${d.weekday}`;
    return `Weekly (${day}) at ${d.time}`;
  }
  if (d.kind === 'once') return d.datetime ? `Once on ${d.datetime.replace('T', ' ')}` : 'Once (set date)';
  return d.cronExpr ? `Cron: ${d.cronExpr}` : 'Custom cron';
}

export function intervalMs(every: number, unit: ScheduleDraft['unit']): number {
  const n = Math.max(1, every || 1);
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60_000;
  if (unit === 'h') return n * 3_600_000;
  return n * 86_400_000;
}
