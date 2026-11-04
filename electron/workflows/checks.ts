import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import type { CheckDef, CheckResult } from '../../src/lib/workflow/types';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const REGEX_TIMEOUT_MS = 2000;
/** Characters that would let a runner output change the meaning of a check command. */
const SHELL_UNSAFE = /[&|<>^"'`$%!;\r\n()]/;

type Filler = (value: string) => string;

/** {{output.key}} and {{workspace}} placeholders inside check fields. */
function fill(text: string, outputs: Record<string, string>, workspace: string, escapeValue: Filler = (v) => v): string {
  return text
    .replace(/\{\{\s*workspace\s*\}\}/g, () => escapeValue(workspace))
    .replace(/\{\{\s*output\.([\w-]+)\s*\}\}/g, (_, k: string) => escapeValue(outputs[k] ?? ''));
}

function escapeRegex(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function short(v: string, max = 200): string {
  return v.length > max ? `${v.slice(0, max)}...` : v;
}

function resolvePath(p: string, workspace: string): string {
  return path.isAbsolute(p) ? p : path.join(workspace, p);
}

const REGEX_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  parentPort.postMessage({ ok: new RegExp(workerData.pattern, workerData.flags).test(workerData.text) });
} catch (e) {
  parentPort.postMessage({ error: String((e && e.message) || e) });
}`;

/** Runs off the main thread so a catastrophic pattern cannot freeze the app. */
function regexTest(pattern: string, flags: string, text: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(REGEX_WORKER, { eval: true, workerData: { pattern, flags, text } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`pattern took longer than ${REGEX_TIMEOUT_MS / 1000}s, simplify it`))),
      REGEX_TIMEOUT_MS
    );
    worker.once('message', (m: { ok?: boolean; error?: string }) =>
      finish(() => (m.error ? reject(new Error(m.error)) : resolve(Boolean(m.ok))))
    );
    worker.once('error', (e) => finish(() => reject(e)));
    worker.once('exit', (code) => finish(() => reject(new Error(`regex worker exited with code ${code}`))));
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function runCommand(cmd: string, cwd: string, timeoutS: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = exec(
      cmd,
      { cwd, windowsHide: true, maxBuffer: 1024 * 1024, ...(process.platform === 'win32' ? {} : { detached: true }) },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        const out = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
        const tail = out.length > 600 ? `...${out.slice(-600)}` : out;
        if (error || timedOut) {
          const why = timedOut ? `timed out after ${timeoutS}s` : `exit code ${error?.code ?? 'error'}`;
          resolve({ type: 'command', ok: false, detail: `\`${cmd}\` ${why}. ${tail}`.trim() });
          return;
        }
        resolve({ type: 'command', ok: true, detail: `\`${cmd}\` exit 0. ${tail}`.trim() });
      }
    );
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutS * 1000);
  });
}

async function runOne(c: CheckDef, outputs: Record<string, string>, workspace: string): Promise<CheckResult> {
  if (c.type === 'file_exists') {
    const p = resolvePath(fill(c.path, outputs, workspace), workspace);
    const ok = fs.existsSync(p);
    return { type: c.type, ok, detail: ok ? `${p} exists` : `${p} does not exist` };
  }
  if (c.type === 'file_contains') {
    const p = resolvePath(fill(c.path, outputs, workspace), workspace);
    if (!fs.existsSync(p)) return { type: c.type, ok: false, detail: `${p} does not exist` };
    const size = fs.statSync(p).size;
    if (size > MAX_FILE_BYTES) return { type: c.type, ok: false, detail: `${p} is larger than 5 MB` };
    const text = fs.readFileSync(p, 'utf8');
    const ok = await regexTest(fill(c.pattern, outputs, workspace, escapeRegex), 'm', text);
    return { type: c.type, ok, detail: ok ? `${p} matches /${c.pattern}/` : `${p} does not match /${c.pattern}/` };
  }
  if (c.type === 'output_matches') {
    const v = String(outputs[c.key] ?? '');
    const ok = await regexTest(c.pattern, '', v);
    const shown = short(v);
    return {
      type: c.type,
      ok,
      detail: ok ? `output ${c.key}="${shown}" matches /${c.pattern}/` : `output ${c.key}="${shown}" does not match /${c.pattern}/`,
    };
  }
  const unsafe = Object.entries(outputs).find(
    ([k, v]) => new RegExp(`\\{\\{\\s*output\\.${escapeRegex(k)}\\s*\\}\\}`).test(c.run) && SHELL_UNSAFE.test(v)
  );
  if (unsafe) {
    return {
      type: c.type,
      ok: false,
      detail: `output ${unsafe[0]} contains shell characters and cannot be used in a command check. Report a plain value.`,
    };
  }
  return runCommand(fill(c.run, outputs, workspace), workspace, c.timeout_s ?? 60);
}

/** Run every hard check of a step. Never throws: a broken check is a failed check. */
export async function runChecks(
  checks: CheckDef[],
  outputs: Record<string, string>,
  workspace: string
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    try {
      results.push(await runOne(c, outputs, workspace));
    } catch (e) {
      results.push({ type: c.type, ok: false, detail: `check error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return results;
}
