import type { Page } from "@playwright/test";

type Presence = {
  playhead_sec?: number | null;
  meta?: {
    following?: string | null;
    transport?: { playhead_sec?: number | null };
  };
};
export type FollowerWire = {
  sequence: number;
  clientId: string;
  uncertain: boolean;
  sockets: {
    id: number;
    closed: boolean;
    closeSequence: number | null;
    helloSequence: number | null;
  }[];
  sent: { socketId: number; sequence: number; frame: Presence }[];
};

/** Passive recording of actual app socket events; no state/frames are invented or changed. */
export async function installFollowerWireProbe(page: Page) {
  await page.addInitScript(() => {
    const state: FollowerWire = {
      sequence: 0,
      clientId: "",
      uncertain: false,
      sockets: [],
      sent: [],
    };
    (
      window as unknown as { paletteFollowerWire: FollowerWire }
    ).paletteFollowerWire = state;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      private probeSocket: FollowerWire["sockets"][number] | null = null;
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (
          !/\/daw\/ws$/.test(
            new URL(String(url), window.location.href).pathname,
          )
        )
          return;
        const socket = {
          id: state.sockets.length + 1,
          closed: false,
          closeSequence: null as number | null,
          helloSequence: null as number | null,
        };
        this.probeSocket = socket;
        state.sockets.push(socket);
        this.addEventListener("close", () => {
          socket.closed = true;
          socket.closeSequence = ++state.sequence;
        });
        this.addEventListener("message", (event) => {
          const sequence = ++state.sequence;
          try {
            if (typeof event.data !== "string") {
              state.uncertain = true;
              return;
            }
            const f = JSON.parse(event.data);
            if (f.plane === "session" && f.client_id)
              state.clientId = f.client_id;
            if (
              f.plane === "session" &&
              f.type === "Snapshot" &&
              f.snapshot &&
              f.client_id
            )
              socket.helloSequence = sequence;
          } catch {
            state.uncertain = true;
          }
        });
      }
      override send(data: Parameters<WebSocket["send"]>[0]) {
        const socket = this.probeSocket;
        if (socket) {
          const sequence = ++state.sequence;
          try {
            if (typeof data !== "string") throw new Error("non-text app frame");
            const f = JSON.parse(data);
            if (f.type === "Presence")
              state.sent.push({
                socketId: socket.id,
                sequence,
                frame: {
                  playhead_sec: f.playhead_sec,
                  meta: {
                    following: f.meta?.following,
                    transport: f.meta?.transport
                      ? { playhead_sec: f.meta.transport.playhead_sec }
                      : undefined,
                  },
                },
              });
          } catch {
            state.uncertain = true;
          }
        }
        super.send(data);
      }
    };
  });
}
export function readFollowerWire(page: Page): Promise<FollowerWire> {
  return page.evaluate(
    () =>
      (window as unknown as { paletteFollowerWire: FollowerWire })
        .paletteFollowerWire,
  );
}
