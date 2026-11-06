import { safeStorage, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const SECRETS_FILE = 'secrets.bin';
const OLD_KEY_FILE = 'cursor-api-key.bin';
const OLD_CONNECTORS_FILE = 'connectors.bin';
const OLD_ENV_FILE = '.env';
const META_FILE = 'settings-meta.json';

export const MASK = '**************************';
export const CURSOR_KEY_NAME = 'CURSOR_SDK_API_KEY';
const CONNECTOR_ENV_NAMES = new Set([
  'AGENTMAIL_API_KEY',
  'CONTEXT_DEV_API_KEY',
  'ELEVENLABS_API_KEY',
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GITHUB_TOKEN',
]);

export type SecretsBlob = {
  cursorApiKey?: string;
  env?: Record<string, string>;
  connectors?: Record<string, unknown>;
};

type Meta = {
  selectedModel?: string;
  accountName?: string;
};

function secretsPath(): string {
  return path.join(app.getPath('userData'), SECRETS_FILE);
}

function metaPath(): string {
  return path.join(app.getPath('userData'), META_FILE);
}

function userFile(name: string): string {
  return path.join(app.getPath('userData'), name);
}

function decodeBuf(buf: Buffer): string | null {
  const asText = buf.toString('utf8');
  if (asText.startsWith('plain:')) {
    return Buffer.from(asText.slice(6), 'base64').toString('utf8');
  }
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

function encodeStr(json: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(json);
  return Buffer.from(`plain:${Buffer.from(json, 'utf8').toString('base64')}`, 'utf8');
}

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function readOldBinJson(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = decodeBuf(fs.readFileSync(file));
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readOldApiKey(): string | null {
  try {
    if (!fs.existsSync(userFile(OLD_KEY_FILE))) return null;
    return decodeBuf(fs.readFileSync(userFile(OLD_KEY_FILE)));
  } catch {
    return null;
  }
}

let cache: SecretsBlob | null = null;

function migrateInto(blob: SecretsBlob): { blob: SecretsBlob; dirty: boolean } {
  let dirty = false;
  const next: SecretsBlob = {
    cursorApiKey: blob.cursorApiKey,
    env: { ...(blob.env || {}) },
    connectors: { ...(blob.connectors || {}) },
  };
  if (!next.cursorApiKey) {
    const old = readOldApiKey();
    if (old) {
      next.cursorApiKey = old;
      dirty = true;
    }
  }
  const oldConn = readOldBinJson(userFile(OLD_CONNECTORS_FILE));
  if (oldConn) {
    next.connectors = { ...oldConn, ...(next.connectors || {}) };
    dirty = true;
  }
  try {
    const envPath = userFile(OLD_ENV_FILE);
    if (fs.existsSync(envPath)) {
      const parsed = parseEnvText(fs.readFileSync(envPath, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (k === 'CURSOR_API_KEY' && !next.cursorApiKey) {
          next.cursorApiKey = v;
          dirty = true;
          continue;
        }
        if (next.env![k] == null) {
          next.env![k] = v;
          dirty = true;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { blob: next, dirty };
}

function unlinkQuiet(file: string): void {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function persist(blob: SecretsBlob): void {
  const json = JSON.stringify(blob);
  const dest = secretsPath();
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, encodeStr(json));
  fs.renameSync(tmp, dest);
  cache = blob;
}

export function readSecrets(): SecretsBlob {
  if (cache) return cache;
  let blob: SecretsBlob = {};
  try {
    if (fs.existsSync(secretsPath())) {
      const raw = decodeBuf(fs.readFileSync(secretsPath()));
      if (raw) {
        const v = JSON.parse(raw) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) blob = v as SecretsBlob;
      }
    }
  } catch {
    blob = {};
  }
  if (!blob.env) blob.env = {};
  if (!blob.connectors) blob.connectors = {};
  const migrated = migrateInto(blob);
  blob = migrated.blob;
  cache = blob;
  if (migrated.dirty || !fs.existsSync(secretsPath())) {
    persist(blob);
    unlinkQuiet(userFile(OLD_KEY_FILE));
    unlinkQuiet(userFile(OLD_CONNECTORS_FILE));
    unlinkQuiet(userFile(OLD_ENV_FILE));
  }
  return blob;
}

export function writeSecrets(patch: Partial<SecretsBlob>): SecretsBlob {
  const cur = readSecrets();
  const next: SecretsBlob = {
    cursorApiKey: patch.cursorApiKey !== undefined ? patch.cursorApiKey : cur.cursorApiKey,
    env: patch.env !== undefined ? patch.env : { ...(cur.env || {}) },
    connectors: patch.connectors !== undefined ? patch.connectors : { ...(cur.connectors || {}) },
  };
  persist(next);
  return next;
}

export function getConnectors(): Record<string, unknown> {
  return { ...(readSecrets().connectors || {}) };
}

export function setConnectors(next: Record<string, unknown>): void {
  writeSecrets({ connectors: next });
}

export function getEnvMap(): Record<string, string> {
  return { ...(readSecrets().env || {}) };
}

export function listEnvPublic(): Array<{ name: string; masked: string }> {
  return Object.keys(getEnvMap())
    .filter((name) => name !== CURSOR_KEY_NAME && !CONNECTOR_ENV_NAMES.has(name))
    .sort()
    .map((name) => ({ name, masked: MASK }));
}

/** Names agents may fetch. Not OS env. Host decrypts secrets.bin. */
export function agentSecretNames(): string[] {
  return listEnvPublic().map((r) => r.name);
}

export function revealAgentSecret(name: string): { ok: boolean; error?: string; name?: string; value?: string } {
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: 'name is required' };
  if (n === CURSOR_KEY_NAME) return { ok: false, error: 'CURSOR_SDK_API_KEY is host-only' };
  if (CONNECTOR_ENV_NAMES.has(n)) return { ok: false, error: 'Use Settings, Connectors for this key' };
  const v = getEnvMap()[n];
  if (v == null || v === '') return { ok: false, error: 'Unknown secret name' };
  return { ok: true, name: n, value: v };
}

export function formatSecretsBlock(baseUrl: string): string {
  const names = agentSecretNames();
  const base = baseUrl.replace(/\/+$/, '');
  return [
    '[Secrets]',
    'Store: secrets.bin in App data (Settings → API Keys). The host decrypts it. You never open or decrypt that file.',
    'There is no OS environment for these keys. Do not use $env:NAME, %NAME%, or process.env. Do not search ~/.ssh or the disk for keys. Do not write key files.',
    names.length
      ? 'Names this install:\n' + names.map((n) => `- ${n}`).join('\n')
      : 'No extra API Keys saved yet.',
    `List names: GET ${base}/api/secrets (no values). Values stay in the host.`,
    'Put ${env:NAME} in MCP JSON. Never print secrets. Never store them in Soul, memory.md, notes, workspace, or chat.',
    'In MCP JSON, ${env:NAME} is a host placeholder filled from secrets.bin. Same store. Still not OS env.',
    '[/Secrets]',
  ].join('\n');
}

export function revealSecret(name: string): string {
  const n = String(name || '').trim();
  if (n === CURSOR_KEY_NAME) return getApiKey() || '';
  return getEnvMap()[n] || '';
}

export function setEnvValue(name: string, value: string): { ok: boolean; error?: string } {
  const key = String(name || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false, error: 'Invalid name' };
  if (CONNECTOR_ENV_NAMES.has(key)) return { ok: false, error: 'Use Settings, Connectors for this key' };
  const val = String(value ?? '');
  if (!val.trim() || isMasked(val)) return { ok: false, error: 'Enter a new value' };
  const env = getEnvMap();
  env[key] = val;
  writeSecrets({ env });
  return { ok: true };
}

export function deleteEnvValue(name: string): { ok: true } {
  const env = getEnvMap();
  delete env[String(name || '')];
  writeSecrets({ env });
  return { ok: true };
}

export function isMasked(value: string): boolean {
  return !String(value || '').trim() || /^[\s*•]+$/.test(String(value));
}

export function keepSecret(input: string, stored: string | undefined): string {
  const t = String(input || '').trim();
  if (isMasked(t)) return String(stored || '');
  return t;
}

export function saveApiKey(apiKey: string): { ok: boolean; error?: string } {
  try {
    if (isMasked(apiKey)) return { ok: true };
    writeSecrets({ cursorApiKey: apiKey });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function getApiKey(): string | null {
  const v = readSecrets().cursorApiKey;
  return v ? v : null;
}

export function clearApiKey(): void {
  const cur = readSecrets();
  persist({ ...cur, cursorApiKey: '' });
}

export function hasApiKey(): boolean {
  return Boolean(getApiKey());
}

export function readMeta(): Meta {
  try {
    if (!fs.existsSync(metaPath())) return {};
    return JSON.parse(fs.readFileSync(metaPath(), 'utf8')) as Meta;
  } catch {
    return {};
  }
}

export function writeMeta(patch: Partial<Meta>): Meta {
  const next = { ...readMeta(), ...patch };
  fs.writeFileSync(metaPath(), JSON.stringify(next, null, 2));
  return next;
}
