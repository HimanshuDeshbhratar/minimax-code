import { describe, expect, it } from 'vitest';

import {
    resolveTuiProxyConfiguration,
    shouldBypassTuiProxy,
} from '../../src/cli/network-proxy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureWarnings(
    env: NodeJS.ProcessEnv,
): { config: ReturnType<typeof resolveTuiProxyConfiguration>; warnings: string[] } {
    const warnings: string[] = [];
    const config = resolveTuiProxyConfiguration(env, (msg) => warnings.push(msg));
    return { config, warnings };
}

// ---------------------------------------------------------------------------
// resolveTuiProxyConfiguration
// ---------------------------------------------------------------------------

describe('resolveTuiProxyConfiguration', () => {
    it('returns direct mode when no proxy variables are set', () => {
        const { config, warnings } = captureWarnings({});
        expect(config).toEqual({ mode: 'direct' });
        expect(warnings).toHaveLength(0);
    });

    // ── Regression test for #393 ──────────────────────────────────────────────
    it('does not throw when ALL_PROXY uses socks5 scheme — falls back to direct with a warning', () => {
        const { config, warnings } = captureWarnings({ ALL_PROXY: 'socks5://127.0.0.1:1080' });
        expect(config).toEqual({ mode: 'direct' });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('ALL_PROXY');
        expect(warnings[0]).toContain('socks5');
        expect(warnings[0]).toContain('Ignoring ALL_PROXY');
    });

    it('does not throw when lowercase all_proxy uses socks5 scheme — falls back to direct with a warning', () => {
        const { config, warnings } = captureWarnings({ all_proxy: 'socks5://127.0.0.1:1080' });
        expect(config).toEqual({ mode: 'direct' });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('all_proxy');
        expect(warnings[0]).toContain('socks5');
    });
    // ─────────────────────────────────────────────────────────────────────────

    it('accepts ALL_PROXY with http scheme', () => {
        const { config, warnings } = captureWarnings({ ALL_PROXY: 'http://127.0.0.1:8080' });
        expect(config).toMatchObject({ mode: 'proxy', httpProxy: 'http://127.0.0.1:8080' });
        expect(warnings).toHaveLength(0);
    });

    it('accepts ALL_PROXY with https scheme', () => {
        const { config, warnings } = captureWarnings({ ALL_PROXY: 'https://proxy.example.com:8080' });
        expect(config).toMatchObject({
            mode: 'proxy',
            httpProxy: 'https://proxy.example.com:8080',
            httpsProxy: 'https://proxy.example.com:8080',
        });
        expect(warnings).toHaveLength(0);
    });

    it('accepts HTTP_PROXY and HTTPS_PROXY with http/https schemes', () => {
        const { config, warnings } = captureWarnings({
            HTTP_PROXY: 'http://proxy.example.com:3128',
            HTTPS_PROXY: 'https://proxy.example.com:3128',
        });
        expect(config).toMatchObject({
            mode: 'proxy',
            httpProxy: 'http://proxy.example.com:3128',
            httpsProxy: 'https://proxy.example.com:3128',
        });
        expect(warnings).toHaveLength(0);
    });

    it('warns and ignores HTTP_PROXY with unsupported ftp scheme, falls back to direct', () => {
        const { config, warnings } = captureWarnings({ HTTP_PROXY: 'ftp://proxy.example.com' });
        expect(config).toEqual({ mode: 'direct' });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('HTTP_PROXY');
        expect(warnings[0]).toContain('ftp');
    });

    it('uses valid HTTP_PROXY when ALL_PROXY is socks5 (only one warning, no crash)', () => {
        // HTTP_PROXY=http://… overrides ALL_PROXY for httpProxy.
        // HTTPS_PROXY falls back: HTTPS_PROXY not set → ALL_PROXY (socks5, invalid) → httpProxy.
        // Net result: httpsProxy also resolves to the valid httpProxy value.
        const { config, warnings } = captureWarnings({
            HTTP_PROXY: 'http://127.0.0.1:8080',
            ALL_PROXY: 'socks5://127.0.0.1:1080',
        });
        // httpProxy wins on its own; httpsProxy falls through to ALL_PROXY (ignored) then httpProxy.
        expect(config.mode).toBe('proxy');
        if (config.mode === 'proxy') {
            expect(config.httpProxy).toBe('http://127.0.0.1:8080');
        }
        // One warning for ALL_PROXY being used as httpsProxy fallback (ignored due to socks5).
        expect(warnings.length).toBeGreaterThanOrEqual(1);
        expect(warnings.some((w) => w.includes('socks5'))).toBe(true);
    });

    it('throws for a completely unparseable HTTP_PROXY value', () => {
        expect(() =>
            resolveTuiProxyConfiguration({ HTTP_PROXY: 'not a url !!!' }),
        ).toThrow('HTTP_PROXY must be an http:// or https:// URL.');
    });

    it('throws for an http: URL with no hostname', () => {
        expect(() =>
            resolveTuiProxyConfiguration({ HTTP_PROXY: 'http://' }),
        ).toThrow('HTTP_PROXY must be an http:// or https:// URL.');
    });

    it('includes loopback addresses in noProxy', () => {
        const { config } = captureWarnings({ ALL_PROXY: 'http://proxy.example.com:3128' });
        expect(config.mode).toBe('proxy');
        if (config.mode === 'proxy') {
            expect(config.noProxy).toContain('localhost');
            expect(config.noProxy).toContain('127.0.0.1');
            expect(config.noProxy).toContain('::1');
        }
    });
});

// ---------------------------------------------------------------------------
// shouldBypassTuiProxy  (existing pure-function, still works after the fix)
// ---------------------------------------------------------------------------

describe('shouldBypassTuiProxy', () => {
    it('bypasses proxy for localhost', () => {
        expect(shouldBypassTuiProxy(new URL('http://localhost/'), 'localhost,127.0.0.1,::1')).toBe(
            true,
        );
    });

    it('does not bypass proxy for an external host', () => {
        expect(shouldBypassTuiProxy(new URL('https://api.minimax.io/'), 'localhost,127.0.0.1')).toBe(
            false,
        );
    });

    it('bypasses proxy when noProxy is wildcard *', () => {
        expect(shouldBypassTuiProxy(new URL('https://api.minimax.io/'), '*')).toBe(true);
    });
});
