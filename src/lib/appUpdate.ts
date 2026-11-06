export const LATEST_JSON_URL = 'https://tecadrise.ai/downloads/tecadrisebot/latest.json';
export const PRODUCT_PAGE_URL = 'https://tecadrise.ai/products/tecadrisebot';
export const GITHUB_REPO_URL = 'https://github.com/tecadrise-ai/TecAdRiseBot';

export type LatestRelease = {
  name: string;
  version: string;
  gitTag: string;
  gitCommit: string;
  gitRepo: string;
  setupUrl: string;
  sha256: string;
  releasedAt: string;
};

export function parseLatestRelease(raw: unknown): LatestRelease | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const version = String(o.version || '').trim();
  const setupUrl = String(o.setupUrl || o.setup_url || '').trim();
  const sha256 = String(o.sha256 || '').trim().toLowerCase();
  const gitCommit = String(o.gitCommit || o.git_commit || '').trim();
  const gitTag = String(o.gitTag || o.git_tag || (version ? `v${version}` : '')).trim();
  const gitRepo = String(o.gitRepo || o.git_repo || GITHUB_REPO_URL).trim() || GITHUB_REPO_URL;
  const name = String(o.name || 'TecAdRiseBot').trim() || 'TecAdRiseBot';
  const releasedAt = String(o.releasedAt || o.released_at || '').trim();
  if (!/^\d+\.\d+\.\d+/.test(version) || !/^https:\/\//i.test(setupUrl)) return null;
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) return null;
  return { name, version, gitTag, gitCommit, gitRepo, setupUrl, sha256, releasedAt };
}

/** -1 if a < b, 0 if equal, 1 if a > b. Non-numeric bits are ignored. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(/[+-]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[+-]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

export type UpdateStatus = 'loading' | 'current' | 'available' | 'ahead' | 'error';

export function statusFor(localVersion: string, latest: LatestRelease | null, fetchError: boolean): UpdateStatus {
  if (fetchError) return 'error';
  if (!latest) return 'loading';
  const c = compareSemver(localVersion, latest.version);
  if (c < 0) return 'available';
  if (c > 0) return 'ahead';
  return 'current';
}

export function githubTreeUrl(latest: LatestRelease): string {
  const base = (latest.gitRepo || GITHUB_REPO_URL).replace(/\/$/, '');
  if (latest.gitCommit) return `${base}/tree/${latest.gitCommit}`;
  if (latest.gitTag) return `${base}/releases/tag/${latest.gitTag}`;
  return base;
}
