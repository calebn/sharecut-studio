import { useEffect, useState } from "react";
import type { PipelineJobSnapshot } from "../types/pipeline";
import {
  type GuestProgressEvent,
  guestProgressToJob,
  guestProgressWsUrl,
} from "../utils/guestProgress";

const RECONNECT_MS = 2000;

/** ReviewApp progress chip — same WS plane as guest Studio, token-scoped. */
export function useGuestProgress(token: string): PipelineJobSnapshot | null {
  const [job, setJob] = useState<PipelineJobSnapshot | null>(null);
  useEffect(() => {
    if (!token) {
      return;
    }
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (closed) {
        return;
      }
      ws = new WebSocket(guestProgressWsUrl(token));
      const thisSocket = ws;
      ws.onmessage = (ev) => {
        if (closed) {
          return;
        }
        try {
          const msg = JSON.parse(ev.data as string) as GuestProgressEvent;
          setJob((prev) => guestProgressToJob(msg, prev));
        } catch {
          return;
        }
      };
      ws.onclose = () => {
        if (thisSocket !== ws || closed) {
          return;
        }
        retry = setTimeout(connect, RECONNECT_MS);
      };
      ws.onerror = () => {
        if (thisSocket === ws) {
          ws?.close();
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) {
        clearTimeout(retry);
      }
      ws?.close();
    };
  }, [token]);
  return job;
}
