import type { ScheduleDraft } from '../lib/schedule';
import { KINDS, UNITS, WEEKDAYS, describeSchedule, encodeSchedule } from '../lib/schedule';

type Props = {
  value: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
};

export function ScheduleBuilder({ value, onChange }: Props) {
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch });
  const showInterval = value.kind === 'loop' || value.kind === 'interval';

  return (
    <div className="schedule-builder aos-trigger">
      <label className="field">
        <span>Schedule type</span>
        <select value={value.kind} onChange={(e) => set({ kind: e.target.value as ScheduleDraft['kind'] })}>
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </label>

      {showInterval && (
        <div className="schedule-ui-grid">
          <label className="field">
            <span>Every</span>
            <input
              type="number"
              min={1}
              value={value.every}
              onChange={(e) => set({ every: Math.max(1, parseInt(e.target.value, 10) || 1) })}
            />
          </label>
          <label className="field">
            <span>Unit</span>
            <select
              value={value.unit}
              onChange={(e) => set({ unit: e.target.value as ScheduleDraft['unit'] })}
            >
              {UNITS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {value.kind === 'loop' && (
        <p className="hint">Loop runs tasks immediately, waits the delay, then repeats until disabled.</p>
      )}

      {value.kind === 'daily' && (
        <label className="field">
          <span>Time</span>
          <input type="time" value={value.time} onChange={(e) => set({ time: e.target.value })} />
        </label>
      )}

      {value.kind === 'weekly' && (
        <div className="schedule-ui-grid">
          <label className="field">
            <span>Day of week</span>
            <select
              value={value.weekday}
              onChange={(e) => set({ weekday: parseInt(e.target.value, 10) })}
            >
              {WEEKDAYS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Time</span>
            <input type="time" value={value.time} onChange={(e) => set({ time: e.target.value })} />
          </label>
        </div>
      )}

      {value.kind === 'once' && (
        <label className="field">
          <span>Date and time</span>
          <input
            type="datetime-local"
            value={value.datetime}
            onChange={(e) => set({ datetime: e.target.value })}
          />
        </label>
      )}

      {value.kind === 'cron' && (
        <label className="field">
          <span>Cron expression</span>
          <input
            type="text"
            value={value.cronExpr}
            placeholder="* * * * *"
            autoComplete="off"
            onChange={(e) => set({ cronExpr: e.target.value })}
          />
          <span className="hint">Format: minute hour day month day-of-week</span>
        </label>
      )}

      <div className="schedule-summary">{describeSchedule(encodeSchedule(value))}</div>
    </div>
  );
}
