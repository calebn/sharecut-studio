import type { CSSProperties, RefObject } from "react";
import { useEffect, useRef } from "react";
import { useDawStore } from "../state/dawStore";
import type { SessionSelection } from "../types/session";
import { presenceAnchor, resolvePresenceAnchor } from "./anchors";
import { presenceColorVar, rosterDisplayName } from "./colors";
import { createCursorMotion } from "./cursorMotion";
import { remotePresenceClients, serverNowMs } from "./followSync";

type Props = {
  rootRef: RefObject<HTMLElement | null>;
};

type AnchorCache = { anchor: string; el: HTMLElement };

function wordSelectionAnchors(
  sel: SessionSelection | null | undefined,
): { start: string; end: string } | null {
  if (
    (sel?.kind !== "transcriptWord" && sel?.kind !== "transcriptRange") ||
    !sel.track_id ||
    sel.word_index == null
  ) {
    return null;
  }
  const endIdx =
    sel.kind === "transcriptRange"
      ? (sel.word_end ?? sel.word_index)
      : sel.word_index;
  return {
    start: presenceAnchor("transcript", "word", sel.track_id, sel.word_index),
    end: presenceAnchor("transcript", "word", sel.track_id, endIdx),
  };
}

function resolveCached(
  cache: Map<string, AnchorCache>,
  key: string,
  anchor: string,
  scope: ParentNode | Document,
): HTMLElement | null {
  const hit = cache.get(key);
  if (hit && hit.anchor === anchor && hit.el.isConnected) {
    return hit.el;
  }
  const el = resolvePresenceAnchor(scope, anchor);
  if (el) {
    cache.set(key, { anchor, el });
  } else {
    cache.delete(key);
  }
  return el;
}

function unionRect(
  a: DOMRect,
  b: DOMRect,
): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.right, b.right);
  const bottom = Math.max(a.bottom, b.bottom);
  return { left, top, width: right - left, height: bottom - top };
}

export function PresenceGhostLayer({ rootRef }: Props) {
  const sessionClients = useDawStore((s) => s.sessionClients);
  const localClientId = useDawStore((s) => s.localClientId);
  const offsetMs = useDawStore((s) => s.serverClockOffsetMs);
  const now = serverNowMs(offsetMs);
  const others = remotePresenceClients(
    sessionClients,
    localClientId,
    now,
  ).filter(
    (c) => c.meta?.cursor?.anchor || wordSelectionAnchors(c.meta?.selection),
  );
  const cursorEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const selEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const targetCache = useRef<Map<string, AnchorCache>>(new Map());
  const motion = useRef(createCursorMotion());
  const othersRef = useRef(others);
  othersRef.current = others;
  const root = rootRef;

  useEffect(() => {
    if (others.length === 0) {
      return;
    }
    let raf = 0;
    const tick = () => {
      const scope = root.current ?? document;
      const cache = targetCache.current;
      for (const c of othersRef.current) {
        const cursor = c.meta?.cursor;
        const el = cursorEls.current.get(c.client_id);
        if (cursor?.anchor && el) {
          const target = resolveCached(
            cache,
            c.client_id,
            cursor.anchor,
            scope,
          );
          const rect = target?.getBoundingClientRect();
          if (!rect || rect.width < 1 || rect.height < 1) {
            el.style.display = "none";
          } else {
            el.style.display = "";
            const x = cursor.x ?? 0.5;
            const y = cursor.y ?? 0.5;
            motion.current.step(
              c.client_id,
              {
                left: rect.left + rect.width * x,
                top: rect.top + rect.height * y,
              },
              el,
              `${cursor.anchor}:${x}:${y}`,
            );
          }
        }
        const words = wordSelectionAnchors(c.meta?.selection);
        const box = selEls.current.get(c.client_id);
        if (words && box) {
          const startEl = resolveCached(
            cache,
            `${c.client_id}:sel-start`,
            words.start,
            scope,
          );
          const endEl =
            words.end === words.start
              ? startEl
              : resolveCached(
                  cache,
                  `${c.client_id}:sel-end`,
                  words.end,
                  scope,
                );
          const startRect = startEl?.getBoundingClientRect();
          const endRect = endEl?.getBoundingClientRect();
          if (
            !startRect ||
            startRect.width < 1 ||
            startRect.height < 1 ||
            !endRect
          ) {
            box.style.display = "none";
          } else {
            const r = unionRect(startRect, endRect);
            box.style.display = "";
            box.style.left = `${r.left}px`;
            box.style.top = `${r.top}px`;
            box.style.width = `${r.width}px`;
            box.style.height = `${r.height}px`;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [others.length, root]);

  if (others.length === 0) {
    return null;
  }

  return (
    <div className="presence-ghost-layer" aria-hidden>
      {others.map((c) => (
        <div key={c.client_id}>
          {c.meta?.cursor?.anchor ? (
            <div
              className="presence-cursor presence-cursor--ghost"
              ref={(el) => {
                if (el) {
                  cursorEls.current.set(c.client_id, el);
                } else {
                  cursorEls.current.delete(c.client_id);
                }
              }}
              style={
                {
                  "--presence-color": presenceColorVar(c.meta?.color_index),
                } as CSSProperties
              }
            >
              <span className="presence-cursor-tag">
                {rosterDisplayName(c)}
              </span>
            </div>
          ) : null}
          {wordSelectionAnchors(c.meta?.selection) ? (
            <div
              className="presence-selection presence-selection--ghost"
              ref={(el) => {
                if (el) {
                  selEls.current.set(c.client_id, el);
                } else {
                  selEls.current.delete(c.client_id);
                }
              }}
              style={
                {
                  "--presence-color": presenceColorVar(c.meta?.color_index),
                } as CSSProperties
              }
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
