import { LATEST_JSON_URL, parseLatestRelease, type LatestRelease } from '../src/lib/appUpdate';

export type UpdateCheck = {
  ok: boolean;
  localVersion: string;
  latest: LatestRelease | null;
  error?: string;
};

export async function fetchLatestRelease(localVersion: string): Promise<UpdateCheck> {
  try {
    const res = await fetch(LATEST_JSON_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      return { ok: false, localVersion, latest: null, error: `HTTP ${res.status}` };
    }
    const latest = parseLatestRelease(await res.json());
    if (!latest) {
      return { ok: false, localVersion, latest: null, error: 'latest.json is not a release record' };
    }
    return { ok: true, localVersion, latest };
  } catch (e) {
    return { ok: false, localVersion, latest: null, error: e instanceof Error ? e.message : 'network error' };
  }
}
