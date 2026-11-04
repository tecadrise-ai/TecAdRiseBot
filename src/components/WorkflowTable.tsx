import { DEFAULT_MAX_ATTEMPTS } from '../lib/workflow/definition';

type RawStep = Record<string, unknown>;
type RawDef = { name?: unknown; description?: unknown; steps?: unknown } & Record<string, unknown>;

type Props = {
  json: string;
  onChange: (json: string) => void;
};

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function checkLabel(c: unknown): string {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
  switch (o.type) {
    case 'file_exists':
      return `file exists: ${text(o.path)}`;
    case 'file_contains':
      return `${text(o.path)} contains "${text(o.pattern)}"`;
    case 'output_matches':
      return `output ${text(o.key)} matches "${text(o.pattern)}"`;
    case 'command':
      return `command: ${text(o.run)}`;
    default:
      return String(o.type ?? 'unknown check');
  }
}

/** Table view over the workflow JSON. Edits write back to the JSON, checks are edited in JSON only. */
export function WorkflowTable({ json, onChange }: Props) {
  let def: RawDef;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    def = parsed as RawDef;
  } catch {
    return <div className="wf-table-error">The JSON is not valid. Fix it in the JSON view to use the table.</div>;
  }
  const steps: RawStep[] = Array.isArray(def.steps)
    ? def.steps.map((s) => (s && typeof s === 'object' ? (s as RawStep) : {}))
    : [];

  const write = (next: RawDef) => onChange(JSON.stringify(next, null, 2));
  const setTop = (key: 'name' | 'description', value: string) => write({ ...def, [key]: value });
  const setStep = (i: number, key: string, value: unknown) =>
    write({ ...def, steps: steps.map((s, j) => (j === i ? { ...s, [key]: value } : s)) });

  return (
    <div className="wf-table-wrap">
      <div className="wf-table-head">
        <label className="field">
          <span>Name</span>
          <input value={text(def.name)} onChange={(e) => setTop('name', e.target.value)} />
        </label>
        <label className="field">
          <span>Description</span>
          <input value={text(def.description)} onChange={(e) => setTop('description', e.target.value)} />
        </label>
      </div>
      <table className="wf-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Instructions</th>
            <th>Done when</th>
            <th>Checks (app)</th>
            <th>Owner review</th>
            <th>Max tries</th>
            <th>Skippable</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => {
            const checks = Array.isArray(s.checks) ? s.checks : [];
            return (
              <tr key={i}>
                <td className="wf-table-num">{i + 1}</td>
                <td>
                  <textarea rows={2} value={text(s.title)} onChange={(e) => setStep(i, 'title', e.target.value)} />
                </td>
                <td>
                  <textarea
                    rows={4}
                    value={text(s.instructions)}
                    onChange={(e) => setStep(i, 'instructions', e.target.value)}
                  />
                </td>
                <td>
                  <textarea rows={4} value={text(s.done_when)} onChange={(e) => setStep(i, 'done_when', e.target.value)} />
                </td>
                <td className="wf-table-checks">
                  {checks.length ? checks.map((c, k) => <div key={k}>{checkLabel(c)}</div>) : <span className="muted">None</span>}
                </td>
                <td>
                  <select
                    value={s.validate === 'owner' ? 'owner' : 'none'}
                    onChange={(e) => setStep(i, 'validate', e.target.value)}
                  >
                    <option value="none">Off</option>
                    <option value="owner">On</option>
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={typeof s.max_attempts === 'number' ? s.max_attempts : DEFAULT_MAX_ATTEMPTS}
                    onChange={(e) => setStep(i, 'max_attempts', Number(e.target.value) || 1)}
                  />
                </td>
                <td className="wf-table-center">
                  <input
                    type="checkbox"
                    checked={s.skippable === true}
                    onChange={(e) => setStep(i, 'skippable', e.target.checked)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
