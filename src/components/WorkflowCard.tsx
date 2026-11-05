import { useState } from 'react';
import type { StepStatus, WorkflowRunView } from '../types';

const MARK: Record<StepStatus, string> = {
  pending: '[ ]',
  active: '[~]',
  review: '[?]',
  passed: '[x]',
  failed: '[!]',
  skipped: '[-]',
};

const STATE_LABEL: Record<WorkflowRunView['state'], string> = {
  running: 'Running',
  awaiting_review: 'Owner review',
  needs_fix: 'Owner fixing',
  blocked: 'Blocked',
  done: 'Done',
  aborted: 'Aborted',
};

const IN_FLIGHT: Record<string, string> = {
  runner: 'runner working',
  review: 'owner reviewing',
  fix: 'owner fixing',
};

function oneLine(s: string | undefined, max = 160): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Props = {
  run: WorkflowRunView;
  /** Older bubbles of the same run show one line only. */
  compact?: boolean;
};

export function WorkflowCard({ run, compact = false }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const done = run.steps.filter((s) => s.status === 'passed' || s.status === 'skipped').length;
  const total = run.steps.length;
  const cur = run.definition.steps[run.currentIndex];

  if (compact) {
    return (
      <div className={`wf-chip wf-${run.state}`}>
        Workflow {run.workflowName} · step {Math.min(run.currentIndex + 1, total)}/{total} · {cur?.title}
      </div>
    );
  }

  async function act(action: 'retry' | 'skip' | 'abort') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await window.tecapi.workflows.action(run.id, action);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canFix = run.state === 'blocked' || run.state === 'needs_fix';
  const canResume = run.state === 'aborted';
  const showActions = run.state !== 'done';

  return (
    <div className={`wf-card wf-${run.state}`}>
      <div className="wf-head">
        <span className="wf-title">
          Workflow · {run.workflowName} <span className="wf-ver">v{run.version}</span>
          {run.runnerModel ? <span className="wf-ver"> · Runner: {run.runnerModel.replace(/ · /g, ' ')}</span> : null}
        </span>
        <span className={`wf-state wf-state-${run.state}`}>{STATE_LABEL[run.state]}</span>
      </div>
      <div className="wf-sub">
        {fmtTime(run.createdAt)}
        {run.finishedAt ? ` to ${fmtTime(run.finishedAt)}` : ''} · {done}/{total} steps · runner {run.runnerName} · owner{' '}
        {run.ownerName}
        {run.inFlight ? ` · ${IN_FLIGHT[run.inFlight] || run.inFlight}` : ''}
      </div>
      <div className="wf-steps">
        {run.definition.steps.map((def, i) => {
          const st = run.steps[i];
          const failedChecks = (st.checks || []).filter((c) => !c.ok);
          return (
            <div key={def.id} className={`wf-step wf-step-${st.status}`}>
              <span className="tk">{MARK[st.status]}</span>
              <div className="wf-step-body">
                <div className="tx">
                  {def.title}
                  {def.validate === 'owner' ? <span className="wf-tag">review</span> : null}
                  {st.attempts > 0 && st.status !== 'passed' ? (
                    <span className="wf-tag">
                      attempt {Math.min(st.attempts + 1, def.max_attempts)}/{def.max_attempts}
                    </span>
                  ) : null}
                </div>
                {st.result && st.status !== 'pending' ? (
                  <div className="wf-line" title={st.result}>
                    {oneLine(st.result)}
                  </div>
                ) : null}
                {st.status !== 'passed' && failedChecks.length ? (
                  <div className="wf-line wf-bad">Check failed: {oneLine(failedChecks.map((c) => c.detail).join(' | '))}</div>
                ) : null}
                {st.verdict ? (
                  <div className={`wf-line ${st.verdict.pass ? 'wf-good' : 'wf-bad'}`} title={st.verdict.reason}>
                    Owner {st.verdict.pass ? 'passed' : 'rejected'}: {oneLine(st.verdict.reason)}
                  </div>
                ) : null}
                {st.error ? <div className="wf-line wf-bad">{oneLine(st.error)}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
      {run.blockedReason && run.state !== 'done' ? (
        <div className="wf-blocked">
          {run.blockedReason.replace(/Retry( step)? to continue\.?/i, 'Click Retry to continue.')}
        </div>
      ) : null}
      {showActions ? (
        <div className="wf-actions">
          {canResume ? (
            <button type="button" className="text-btn" disabled={busy} onClick={() => void act('retry')}>
              Resume from step {Math.min(run.currentIndex + 1, total)}
            </button>
          ) : null}
          {canFix ? (
            <>
              <button type="button" className="text-btn" disabled={busy} onClick={() => void act('retry')}>
                Retry
              </button>
              <button type="button" className="text-btn" disabled={busy} onClick={() => void act('skip')}>
                Skip step
              </button>
            </>
          ) : null}
          {!canResume ? (
            <button type="button" className="text-btn danger-text" disabled={busy} onClick={() => void act('abort')}>
              Abort run
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <div className="wf-line wf-bad">{error}</div> : null}
    </div>
  );
}
