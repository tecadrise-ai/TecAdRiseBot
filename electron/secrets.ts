import { safeStorage, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const KEY_FILE = 'cursor-api-key.bin';
const META_FILE = 'settings-meta.json';

function keyPath(): string {
  return path.join(app.getPath('userData'), KEY_FILE);
}

function metaPath(): string {
  return path.join(app.getPath('userData'), META_FILE);
}

type Meta = {
  selectedModel?: string;
  accountName?: string;
};

export function saveApiKey(apiKey: string): { ok: boolean; error?: string } {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: still store obfuscated locally (dev machines without keychain)
      const encoded = Buffer.from(apiKey, 'utf8').toString('base64');
      fs.writeFileSync(keyPath(), Buffer.from(`plain:${encoded}`, 'utf8'));
      return { ok: true };
    }
    const encrypted = safeStorage.encryptString(apiKey);
    fs.writeFileSync(keyPath(), encrypted);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function getApiKey(): string | null {
  try {
    if (!fs.existsSync(keyPath())) return null;
    const buf = fs.readFileSync(keyPath());
    const asText = buf.toString('utf8');
    if (asText.startsWith('plain:')) {
      return Buffer.from(asText.slice(6), 'base64').toString('utf8');
    }
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

export function clearApiKey(): void {
  try {
    if (fs.existsSync(keyPath())) fs.unlinkSync(keyPath());
  } catch {
    /* ignore */
  }
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
