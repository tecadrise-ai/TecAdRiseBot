import http from 'node:http';
import https from 'node:https';

/** HTTP/1.1 POST. Node's default fetch uses HTTP/2; NVIDIA NIM resets that as `fetch failed`. */
export function byokPost(
  url: string,
  opts: { headers: Record<string, string>; body: string; signal?: AbortSignal }
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          ...opts.headers,
          'Content-Length': String(Buffer.byteLength(opts.body)),
        },
      },
      (res) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', (chunk: Buffer | string) => {
              controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk));
            });
            res.on('end', () => controller.close());
            res.on('error', (err) => controller.error(err));
          },
          cancel() {
            res.destroy();
          },
        });
        const hdrs = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v == null) continue;
          hdrs.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        }
        resolve(
          new Response(stream, {
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            headers: hdrs,
          })
        );
      }
    );
    req.on('socket', (socket) => {
      socket.setKeepAlive(true, 10_000);
      socket.setNoDelay(true);
    });
    req.on('error', (e) => {
      if (opts.signal?.aborted) {
        reject(Object.assign(new Error('abort'), { name: 'AbortError' }));
        return;
      }
      reject(e);
    });
    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy();
        reject(Object.assign(new Error('abort'), { name: 'AbortError' }));
        return;
      }
      opts.signal.addEventListener(
        'abort',
        () => {
          req.destroy();
        },
        { once: true }
      );
    }
    req.write(opts.body);
    req.end();
  });
}

export function formatByokFetchError(providerName: string, e: unknown): string {
  const err = e as Error & { cause?: { message?: string; code?: string } };
  const parts = [err?.message, err?.cause?.message, err?.cause?.code].filter(Boolean);
  const detail = [...new Set(parts)].join(' — ') || String(e);
  return `${providerName} request failed (${detail}).`;
}

export function isByokRetryable(e: unknown, status?: number): boolean {
  if (status === 504 || status === 502 || status === 429) return true;
  const msg = `${e instanceof Error ? e.message : String(e)} ${
    e && typeof e === 'object' && 'cause' in e ? String((e as { cause?: { message?: string; code?: string } }).cause?.message || (e as { cause?: { code?: string } }).cause?.code || '') : ''
  }`;
  return /socket hang up|ECONNRESET|ECONNABORTED|EPIPE|UND_ERR|ETIMEDOUT/i.test(msg);
}
