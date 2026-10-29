import { validNpmConstraint } from "./npm-spec.js";
import { redact } from "./process.js";

export const PI_RELEASE_URL = "https://pi.dev/api/latest-version";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org";

export interface MetadataClientOptions {
  releaseUrl?: string;
  registryUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface MetadataClient {
  getRelease(): Promise<unknown>;
  getPackument(name: string): Promise<unknown>;
  getManifest(name: string, version: string): Promise<unknown>;
}

function endpoint(value: string): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`metadata endpoint must use HTTPS (or loopback HTTP for tests): ${url.origin}`);
  }
  if (url.username || url.password) throw new Error("metadata endpoints must not contain credentials");
  return url;
}

function packageName(name: string): string {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error(`unsafe npm package name for metadata lookup: ${name}`);
  }
  return name;
}

async function responseText(response: Response, maximum: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maximum) throw new Error(`metadata response exceeds the ${maximum}-byte limit`);
  if (!response.body) throw new Error("metadata response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error(`metadata response exceeds the ${maximum}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function createMetadataClient(options: MetadataClientOptions = {}): MetadataClient {
  const releaseUrl = endpoint(options.releaseUrl ?? PI_RELEASE_URL);
  const registryUrl = endpoint(options.registryUrl ?? NPM_REGISTRY_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 12 * 1024 * 1024;
  const callerSignal = options.signal;

  const getJson = async (url: URL): Promise<unknown> => {
    const display = `${url.origin}${url.pathname}`;
    if (callerSignal?.aborted) throw new Error(`metadata request failed for ${display}: metadata request cancelled`);
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let rejectCancelled: ((reason: unknown) => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    const onCancel = (): void => {
      const error = new Error("metadata request cancelled");
      error.name = "AbortError";
      controller.abort(error);
      rejectCancelled?.(error);
    };
    callerSignal?.addEventListener("abort", onCancel, { once: true });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`metadata request timeout after ${timeoutMs} ms`);
        error.name = "TimeoutError";
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url, {
            headers: { accept: "application/json", "user-agent": "agentbrew/0.1.0" },
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await responseText(response, maxBytes);
          try {
            return JSON.parse(text);
          } catch {
            throw new Error("response is not valid JSON");
          }
        })(),
        timeout,
        cancelled,
      ]);
    } catch (error) {
      throw new Error(`metadata request failed for ${display}: ${redact(error instanceof Error ? error.message : String(error))}`);
    } finally {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCancel);
    }
  };

  return {
    getRelease: () => getJson(releaseUrl),
    getPackument: (name) => {
      const valid = packageName(name);
      const url = new URL(`${registryUrl.origin}${registryUrl.pathname.replace(/\/$/, "")}/${encodeURIComponent(valid)}`);
      return getJson(url);
    },
    getManifest: (name, version) => {
      const valid = packageName(name);
      if (!validNpmConstraint(version, true)) throw new Error(`invalid exact npm version for metadata lookup: ${version}`);
      const url = new URL(`${registryUrl.origin}${registryUrl.pathname.replace(/\/$/, "")}/${encodeURIComponent(valid)}/${version}`);
      return getJson(url);
    },
  };
}
