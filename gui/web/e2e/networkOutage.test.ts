import { describe, expect, it, vi } from "vitest";
import { installNetworkOutage, OUTAGE_CLOSE } from "./networkOutage";

/** A fake `WebSocketRoute` pair: the page-side route and the server it proxies to. */
function fakeWsRoute() {
  const server = { close: vi.fn(async () => undefined) };
  const route = {
    connectToServer: vi.fn(() => server),
    close: vi.fn(async () => undefined),
  };
  return { route, server };
}

/** A fake HTTP `Route`. */
function fakeHttpRoute() {
  return {
    fallback: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
}

/**
 * A fake `Page` exposing only `routeWebSocket` / `route`, capturing the
 * handlers `installNetworkOutage` registers so a test can trigger them
 * directly, the way `keeperOpfs.test.ts` fakes `page.evaluate`.
 */
function fakePage() {
  let wsHandler: ((ws: never) => Promise<void>) | undefined;
  let httpHandler: ((route: never) => Promise<void>) | undefined;
  let httpMatcher: unknown;
  const routeWebSocket = vi.fn(
    async (_pattern: RegExp, handler: (ws: never) => Promise<void>) => {
      wsHandler = handler;
    },
  );
  const route = vi.fn(
    async (matcher: unknown, handler: (route: never) => Promise<void>) => {
      httpMatcher = matcher;
      httpHandler = handler;
    },
  );
  return {
    page: { routeWebSocket, route } as never,
    routeWebSocket,
    route,
    getHttpMatcher: () => httpMatcher,
    triggerWs: async (ws: unknown) => {
      if (!wsHandler) throw new Error("routeWebSocket handler not installed");
      await wsHandler(ws as never);
    },
    triggerHttp: async (httpRoute: unknown) => {
      if (!httpHandler) throw new Error("route handler not installed");
      await httpHandler(httpRoute as never);
    },
  };
}

describe("installNetworkOutage", () => {
  it("proxies a new socket to the server while up", async () => {
    const fp = fakePage();
    await installNetworkOutage(fp.page, { webSocket: /\/ws/ });
    const { route } = fakeWsRoute();
    await fp.triggerWs(route);
    expect(route.connectToServer).toHaveBeenCalledTimes(1);
    expect(route.close).not.toHaveBeenCalled();
  });

  it("drop() closes both sides of every live socket and sets down", async () => {
    const fp = fakePage();
    const outage = await installNetworkOutage(fp.page, { webSocket: /\/ws/ });
    const { route: r1, server: s1 } = fakeWsRoute();
    const { route: r2, server: s2 } = fakeWsRoute();
    await fp.triggerWs(r1);
    await fp.triggerWs(r2);
    expect(outage.down).toBe(false);

    await outage.drop();

    expect(outage.down).toBe(true);
    expect(r1.close).toHaveBeenCalledWith(OUTAGE_CLOSE);
    expect(s1.close).toHaveBeenCalledWith(OUTAGE_CLOSE);
    expect(r2.close).toHaveBeenCalledWith(OUTAGE_CLOSE);
    expect(s2.close).toHaveBeenCalledWith(OUTAGE_CLOSE);
  });

  it("refuses a new socket while down, and reconnects again after restore", async () => {
    const fp = fakePage();
    const outage = await installNetworkOutage(fp.page, { webSocket: /\/ws/ });
    await outage.drop();

    const { route: whileDown } = fakeWsRoute();
    await fp.triggerWs(whileDown);
    expect(whileDown.connectToServer).not.toHaveBeenCalled();
    expect(whileDown.close).toHaveBeenCalledWith(OUTAGE_CLOSE);

    outage.restore();
    expect(outage.down).toBe(false);

    const { route: afterRestore } = fakeWsRoute();
    await fp.triggerWs(afterRestore);
    expect(afterRestore.connectToServer).toHaveBeenCalledTimes(1);
    expect(afterRestore.close).not.toHaveBeenCalled();
  });

  it("does not fail drop() when a socket is already closed", async () => {
    const fp = fakePage();
    const outage = await installNetworkOutage(fp.page, { webSocket: /\/ws/ });
    const { route, server } = fakeWsRoute();
    route.close.mockRejectedValueOnce(new Error("already closed"));
    server.close.mockRejectedValueOnce(new Error("already closed"));
    await fp.triggerWs(route);

    await expect(outage.drop()).resolves.toBeUndefined();
  });

  it("routes matching HTTP with fallback() while up and abort() while down", async () => {
    const fp = fakePage();
    const matcher = (url: URL) => url.pathname.startsWith("/api/rec/");
    const outage = await installNetworkOutage(fp.page, {
      webSocket: /\/ws/,
      http: matcher,
    });
    expect(fp.getHttpMatcher()).toBe(matcher);

    const whileUp = fakeHttpRoute();
    await fp.triggerHttp(whileUp);
    expect(whileUp.fallback).toHaveBeenCalledTimes(1);
    expect(whileUp.abort).not.toHaveBeenCalled();
    expect(outage.blockedHttp).toBe(0);

    await outage.drop();
    const whileDown = fakeHttpRoute();
    await fp.triggerHttp(whileDown);
    expect(whileDown.abort).toHaveBeenCalledWith("internetdisconnected");
    expect(whileDown.fallback).not.toHaveBeenCalled();
    expect(outage.blockedHttp).toBe(1);
  });

  it("never calls page.route without an http matcher", async () => {
    const fp = fakePage();
    await installNetworkOutage(fp.page, { webSocket: /\/ws/ });
    expect(fp.route).not.toHaveBeenCalled();
  });
});
