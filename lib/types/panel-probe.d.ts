/**
 * The M12 panel probe's request shape (F1/F4).
 *
 * A plugin has no client for the host `connection` channel, so the M12 E2E
 * driver calls the production panel handlers in-process with a plain `Request`.
 * `src/api.ts` guards every route with `assertSameOrigin`, which reads the
 * `host` and `origin` headers from that request object: a bare `new Request`
 * carries neither (undici computes Host only when sending), so the probe must
 * state the loopback authority explicitly. This leaf module imports nothing, so
 * both the host and the host-free tests can share one request shape.
 */
/** The loopback authority every probe request claims. */
export declare const PANEL_PROBE_HOST = "127.0.0.1";
/** The origin matching {@link PANEL_PROBE_HOST}; `assertSameOrigin` compares authorities. */
export declare const PANEL_PROBE_ORIGIN = "http://127.0.0.1";
/**
 * The route lookup key of one probe path: the URL pathname. Route registration
 * keys the bare path, so a request that carries `?sessionId=…` must be
 * normalized before the map lookup while the request keeps its query string.
 */
export declare function panelRoutePathname(path: string): string;
/**
 * Build one probe request. `host`/`origin` are probe-owned and always set for
 * the same-origin guard; every other caller header (`content-type` on writes)
 * is preserved, as are the method, body, and the original query string.
 */
export declare function panelProbeRequest(path: string, init?: RequestInit): Request;
