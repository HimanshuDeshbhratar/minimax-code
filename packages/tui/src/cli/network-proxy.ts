import * as undici from 'undici';
import { Agent, Dispatcher, ProxyAgent } from 'undici';

const LOOPBACK_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1'] as const;

interface ProxyValue {
  readonly name: string;
  readonly value: string;
}

export type TuiProxyConfiguration =
  | { readonly mode: 'direct' }
  | {
      readonly mode: 'proxy';
      readonly httpProxy: string;
      readonly httpsProxy: string;
      readonly noProxy: string;
    };

export interface ConfigureTuiNetworkProxyOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly warn?: (message: string) => void;
  readonly createProxyDispatcher?: (options: {
    httpProxy: string;
    httpsProxy: string;
    noProxy: string;
  }) => Dispatcher;
  readonly setGlobalDispatcher?: (dispatcher: Dispatcher) => void;
  readonly installFetch?: () => void;
}

export function resolveTuiProxyConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  warn?: (message: string) => void,
): TuiProxyConfiguration {
  const allProxy = firstProxyValue(environment, 'ALL_PROXY', 'all_proxy');
  const httpProxy = firstProxyValue(environment, 'HTTP_PROXY', 'http_proxy') ?? allProxy;
  const httpsProxy =
    firstProxyValue(environment, 'HTTPS_PROXY', 'https_proxy') ?? allProxy ?? httpProxy;

  if (!httpProxy && !httpsProxy) return { mode: 'direct' };
  const validHttpProxy = validateProxyValue(httpProxy, warn);
  // ALL_PROXY feeds both slots; validating the identical value twice would
  // duplicate the unsupported-scheme warning for a single variable.
  const validHttpsProxy =
    httpsProxy === httpProxy ? validHttpProxy : validateProxyValue(httpsProxy, warn);

  // If every configured proxy was an unsupported scheme, fall back to direct.
  if (!validHttpProxy && !validHttpsProxy) return { mode: 'direct' };

  return {
    mode: 'proxy',
    httpProxy: validHttpProxy?.value ?? '',
    httpsProxy: validHttpsProxy?.value ?? '',
    noProxy: withLoopbackNoProxy(environment.NO_PROXY ?? environment.no_proxy),
  };
}

export function configureTuiNetworkProxy(
  options: ConfigureTuiNetworkProxyOptions = {},
): TuiProxyConfiguration {
  const configuration = resolveTuiProxyConfiguration(options.environment, options.warn);
  if (configuration.mode === 'direct') return configuration;

  const createProxyDispatcher =
    options.createProxyDispatcher ?? ((proxyOptions) => new TuiProxyDispatcher(proxyOptions));
  const dispatcher = createProxyDispatcher({
    httpProxy: configuration.httpProxy,
    httpsProxy: configuration.httpsProxy,
    noProxy: configuration.noProxy,
  });
  (options.setGlobalDispatcher ?? undici.setGlobalDispatcher)(dispatcher);
  (options.installFetch ?? installUndiciFetch)();
  return configuration;
}

function firstProxyValue(
  environment: NodeJS.ProcessEnv,
  ...names: readonly string[]
): ProxyValue | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return { name, value };
  }
  return undefined;
}

function validateProxyValue(
  proxy: ProxyValue | undefined,
  warn?: (message: string) => void,
): ProxyValue | undefined {
  if (!proxy) return undefined;
  let url: URL;
  try {
    url = new URL(proxy.value);
  } catch {
    // Completely unparseable value — always an error regardless of scheme.
    throw new Error(`${proxy.name} must be an http:// or https:// URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // Unsupported scheme (e.g. socks5:) — warn and ignore so the CLI can still start.
    warn?.(
      `Warning: ${proxy.name} uses unsupported scheme "${url.protocol.slice(0, -1)}"; ` +
        `only http and https proxies are supported. Ignoring ${proxy.name}.\n`,
    );
    return undefined;
  }
  if (!url.hostname) {
    throw new Error(`${proxy.name} must be an http:// or https:// URL.`);
  }
  return proxy;
}

function withLoopbackNoProxy(existing: string | undefined): string {
  const entries: string[] = [];
  for (const raw of (existing ?? '').split(',')) {
    const entry = raw.trim();
    if (entry && !entries.includes(entry)) entries.push(entry);
  }
  for (const entry of LOOPBACK_NO_PROXY_ENTRIES) {
    if (!entries.includes(entry)) entries.push(entry);
  }
  return entries.join(',');
}

function installUndiciFetch(): void {
  (undici as typeof undici & { install?: () => void }).install?.();
}

class TuiProxyDispatcher extends Dispatcher {
  readonly #directDispatcher = new Agent();
  readonly #httpDispatcher: Dispatcher;
  readonly #httpsDispatcher: Dispatcher;
  readonly #dispatchers: readonly Dispatcher[];
  readonly #noProxy: string;

  constructor(options: { httpProxy: string; httpsProxy: string; noProxy: string }) {
    super();
    this.#httpDispatcher = options.httpProxy
      ? new ProxyAgent({ uri: options.httpProxy })
      : this.#directDispatcher;
    this.#httpsDispatcher = options.httpsProxy
      ? options.httpsProxy === options.httpProxy
        ? this.#httpDispatcher
        : new ProxyAgent({ uri: options.httpsProxy })
      : this.#directDispatcher;
    this.#dispatchers = [
      ...new Set([this.#directDispatcher, this.#httpDispatcher, this.#httpsDispatcher]),
    ];
    this.#noProxy = options.noProxy;
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const url = new URL(options.origin ?? '');
    if (shouldBypassTuiProxy(url, this.#noProxy)) {
      return this.#directDispatcher.dispatch(options, handler);
    }
    const dispatcher = url.protocol === 'https:' ? this.#httpsDispatcher : this.#httpDispatcher;
    return dispatcher.dispatch(options, handler);
  }

  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | void {
    const operation = Promise.all(this.#dispatchers.map((dispatcher) => dispatcher.close())).then(
      () => undefined,
    );
    if (!callback) return operation;
    void operation.then(callback, callback);
  }

  override destroy(): Promise<void>;
  override destroy(error: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(error: Error | null, callback: () => void): void;
  override destroy(
    errorOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> | void {
    const error = typeof errorOrCallback === 'function' ? null : (errorOrCallback ?? null);
    const completion = typeof errorOrCallback === 'function' ? errorOrCallback : callback;
    const operation = Promise.all(
      this.#dispatchers.map((dispatcher) => dispatcher.destroy(error)),
    ).then(() => undefined);
    if (!completion) return operation;
    void operation.then(completion, completion);
  }
}

export function shouldBypassTuiProxy(url: URL, noProxy: string): boolean {
  const hostname = normalizeHostname(url.hostname);
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  for (const rawEntry of noProxy.split(/[\s,]+/u)) {
    const entry = parseNoProxyEntry(rawEntry);
    if (!entry) continue;
    if (entry.hostname === '*') return true;
    if (entry.port !== undefined && entry.port !== port) continue;
    if (hostname === entry.hostname) return true;
    if (entry.includeSubdomains && hostname.endsWith(`.${entry.hostname}`)) return true;
  }
  return false;
}

function parseNoProxyEntry(
  rawEntry: string,
): { hostname: string; port?: number; includeSubdomains: boolean } | undefined {
  let value = rawEntry.trim().toLowerCase();
  if (!value) return undefined;
  if (value === '*') return { hostname: '*', includeSubdomains: true };

  let port: number | undefined;
  if (value.startsWith('[')) {
    const bracket = value.indexOf(']');
    if (bracket > 0) {
      const suffix = value.slice(bracket + 1);
      if (/^:\d+$/u.test(suffix)) port = Number(suffix.slice(1));
      value = value.slice(1, bracket);
    }
  } else if (value.split(':').length === 2) {
    const [hostname, rawPort] = value.split(':');
    if (hostname && /^\d+$/u.test(rawPort ?? '')) {
      value = hostname;
      port = Number(rawPort);
    }
  }

  const includeSubdomains = value.startsWith('.') || value.startsWith('*');
  value = value.replace(/^\*?\./u, '');
  const hostname = normalizeHostname(value);
  return hostname ? { hostname, port, includeSubdomains } : undefined;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, '');
}
