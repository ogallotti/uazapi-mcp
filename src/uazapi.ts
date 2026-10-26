export interface UazapiCredentials {
  baseUrl: string;
  token: string;
}

export class UazapiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Uazapi respondeu HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
}

const SECRET_KEYS = new Set(['token', 'admintoken', 'openai_apikey']);
const MAX_GET_ATTEMPTS = 3;

export interface CallInput {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

export async function callUazapi(creds: UazapiCredentials, input: CallInput): Promise<unknown> {
  const url = new URL(input.path, creds.baseUrl);
  for (const [k, v] of Object.entries(input.query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
    else url.searchParams.set(k, String(v));
  }
  const init: RequestInit = {
    method: input.method,
    headers: { token: creds.token, accept: 'application/json', 'content-type': 'application/json' },
    body: input.body === undefined || input.method === 'GET' ? undefined : JSON.stringify(input.body),
  };

  // Only reads are retried: a timed-out send may already have been delivered.
  const attempts = input.method === 'GET' ? MAX_GET_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    if (res.ok) return redact(parsed);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= attempts) throw new UazapiError(res.status, redact(parsed));
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 250;
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 5000) + Math.random() * 200));
  }
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.has(k) && typeof v === 'string' && v ? '[redacted]' : redact(v);
  }
  return out;
}

/** Drops empty values so large Uazapi payloads cost fewer tokens in the agent's context. */
export function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const p = prune(v);
    if (p === null || p === undefined || p === '') continue;
    if (Array.isArray(p) && p.length === 0) continue;
    if (typeof p === 'object' && !Array.isArray(p) && Object.keys(p as object).length === 0) continue;
    out[k] = p;
  }
  return out;
}

export function pick<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  return out as Partial<T>;
}
