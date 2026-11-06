import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/** One JSON line per turn. No secret values, no user text. */
export function auditTurn(row: {
  agentId: string;
  agentName: string;
  source?: string;
  attached: string[];
  used: string[];
  inputTokens?: number;
  outputTokens?: number;
}): void {
  try {
    const dir = app.getPath('userData');
    const file = path.join(dir, 'turn-audit.jsonl');
    const line = JSON.stringify({ t: Date.now(), ...row }) + '\n';
    fs.appendFileSync(file, line, 'utf8');
  } catch (e) {
    console.warn('[TecAdRiseBot] audit write failed', e);
  }
}
