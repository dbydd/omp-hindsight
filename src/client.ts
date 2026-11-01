/**
 * Hindsight HTTP 客户端。
 *
 * base 路径统一前缀 `/v1/default/banks/{bank_id}`（研究文档 02-api-surface.md）。
 * 设计约束：
 * - 超时：每次请求一个 AbortSignal.timeout 与调用方 signal 竞争（AbortSignal.any）。
 * - 重试：只对网络错误与 5xx 指数退避，4xx 永不重试；可取消。
 * - 鉴权：apiKeyEnvVar 命名的环境变量，永不从配置读明文。
 * - 密钥不落日志：错误消息只含状态码与端点，不含请求体与 header。
 */

export class HindsightError extends Error {
  readonly status: number | undefined;
  readonly endpoint: string;

  constructor(message: string, endpoint: string, status?: number) {
    super(message);
    this.name = "HindsightError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

export class HindsightClient {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /** 探活：GET /health/ready，超时收紧为短窗。 */
  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.#fetchRaw(`${this.#baseUrl}/health/ready`, { method: "GET", signal });
      await response.arrayBuffer();
      return response.ok;
    } catch {
      return false;
    }
  }

  /** bank 作用域请求：路径相对 `/v1/default/banks/{bankId}`。 */
  async bankRequest<T>(bankId: string, method: string, endpoint: string, options: BankRequestOptions = {}): Promise<T> {
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    return this.#request<T>(`${this.#baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}${path}`, method, options);
  }

  /** 实例级请求（/banks 列表、/health、bank 模板等）。 */
  async request<T>(method: string, endpoint: string, options: BankRequestOptions = {}): Promise<T> {
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    return this.#request<T>(`${this.#baseUrl}${path}`, method, options);
  }

  async #request<T>(url: string, method: string, options: BankRequestOptions): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        if (!(await this.#sleep(delay, options.signal))) throw lastError;
      }
      try {
        return await this.#attempt<T>(url, method, options);
      } catch (error) {
        if (options.signal?.aborted || isAbortError(error)) throw error;
        if (error instanceof HindsightError && error.status !== undefined && error.status < 500) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  async #attempt<T>(url: string, method: string, options: BankRequestOptions): Promise<T> {
    const response = await this.#fetchRaw(url, {
      method,
      signal: options.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      query: options.query,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new HindsightError(`Hindsight ${response.status}: ${truncate(text, 300)}`, url, response.status);
    }
    if (options.raw) return text as T;
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HindsightError(`Hindsight 返回非 JSON（${truncate(text, 120)}）`, url, response.status);
    }
  }

  async #fetchRaw(url: string, init: { method: string; signal?: AbortSignal; body?: string; query?: Record<string, string | undefined> }): Promise<Response> {
    const full = init.query === undefined ? url : withQuery(url, init.query);
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout]);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#apiKey !== undefined) headers["authorization"] = `Bearer ${this.#apiKey}`;
    let response: Response;
    try {
      response = await fetch(full, { method: init.method, headers, body: init.body, signal });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new HindsightError(`Hindsight 不可达：${error instanceof Error ? error.message : String(error)}`, full);
    }
    return response;
  }

  async #sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    return promise;
  }
}

export interface BankRequestOptions {
  readonly body?: unknown;
  readonly query?: Record<string, string | undefined>;
  readonly signal?: AbortSignal;
  /** 返回原始文本而非解析后的 JSON（attachment 字节、导出归档）。 */
  readonly raw?: boolean;
}

function withQuery(url: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value);
  }
  const encoded = params.toString();
  return encoded.length === 0 ? url : `${url}${url.includes("?") ? "&" : "?"}${encoded}`;
}

function truncate(text: string, limit: number): string {
  const clean = text.replaceAll(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}
