import type { Page, Route, WebSocketRoute } from "@playwright/test";

/** Close code for a simulated drop: valid for a native close(), and not the terminal 4403. */
export const OUTAGE_CLOSE = {
  code: 4000,
  reason: "e2e network outage",
} as const;

export type NetworkOutage = {
  /** Close every live matching socket (both sides) and refuse new sockets and matching HTTP until restore(). */
  drop(): Promise<void>;
  /** Let new sockets and HTTP through again; clients reconnect on their own retry timers. */
  restore(): void;
  readonly down: boolean;
  /** HTTP requests aborted while down. */
  readonly blockedHttp: number;
};

export type OutageTarget = Pick<Page, "routeWebSocket" | "route">;

/**
 * Proxy matching WebSockets (and optionally HTTP) through Playwright so a test
 * can cut them like a dropped network. Install before the page opens the
 * sockets: routes only apply to sockets created afterwards.
 */
export async function installNetworkOutage(
  page: OutageTarget,
  { webSocket, http }: { webSocket: RegExp; http?: (url: URL) => boolean },
): Promise<NetworkOutage> {
  let down = false;
  let blockedHttp = 0;
  const live = new Set<{ page: WebSocketRoute; server: WebSocketRoute }>();
  await page.routeWebSocket(webSocket, async (ws) => {
    if (down) {
      // Closed while CONNECTING: the page sees close without open.
      await ws.close(OUTAGE_CLOSE);
      return;
    }
    live.add({ page: ws, server: ws.connectToServer() });
  });
  if (http) {
    await page.route(http, async (route: Route) => {
      if (down) {
        blockedHttp += 1;
        await route.abort("internetdisconnected");
        return;
      }
      await route.fallback();
    });
  }
  return {
    get down() {
      return down;
    },
    get blockedHttp() {
      return blockedHttp;
    },
    async drop() {
      down = true;
      const sockets = [...live];
      live.clear();
      await Promise.all(
        sockets.map(async (pair) => {
          // Already-closed routes make these no-ops; never fail the drop on one.
          await pair.server.close(OUTAGE_CLOSE).catch(() => undefined);
          await pair.page.close(OUTAGE_CLOSE).catch(() => undefined);
        }),
      );
    },
    restore() {
      down = false;
    },
  };
}
