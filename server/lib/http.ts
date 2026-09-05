import iconv from "iconv-lite";

export const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** Response charset for legacy pages ('gb18030'). Omit for UTF-8. */
  charset?: string;
}

async function once(url: string, opts: FetchOpts): Promise<{ status: number; buffer: Buffer }> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) abortFromCaller();
  else opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: { "user-agent": DESKTOP_UA, ...(opts.headers ?? {}) },
      body: opts.body,
      signal: controller.signal,
      redirect: "follow",
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buffer };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/** GET/POST with bounded retries and legacy-charset decoding. */
export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { status, buffer } = await once(url, opts);
      if (status >= 400) throw new HttpError(`HTTP ${status} for ${url}`, status);
      return opts.charset ? iconv.decode(buffer, opts.charset) : buffer.toString("utf8");
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      if (attempt < retries) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            opts.signal?.removeEventListener("abort", onAbort);
            reject(opts.signal?.reason instanceof Error
              ? opts.signal.reason
              : new DOMException("Aborted", "AbortError"));
          };
          const timer = setTimeout(() => {
            opts.signal?.removeEventListener("abort", onAbort);
            resolve();
          }, (opts.retryDelayMs ?? 700) * (attempt + 1));
          if (opts.signal?.aborted) onAbort();
          else opts.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const text = await fetchText(url, opts);
  return JSON.parse(text) as T;
}

/** Run tasks with bounded concurrency and an overall deadline. */
export async function pooled<T, R>(
  items: T[],
  limit: number,
  deadlineAt: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<{ results: R[]; timedOut: boolean }> {
  const results: R[] = [];
  let cursor = 0;
  let timedOut = false;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      if (Date.now() > deadlineAt) {
        timedOut = true;
        return;
      }
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results.push(await worker(items[i], i));
      } catch {
        /* individual failures are tolerated; caller inspects counts */
      }
    }
  });
  await Promise.all(runners);
  return { results, timedOut };
}
