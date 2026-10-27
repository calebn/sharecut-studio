export const PRESENCE_ANCHOR_ATTR = "data-presence-anchor";

export type AnchorKind =
  | "track"
  | "tab"
  | "transcript"
  | "inspector"
  | "ruler"
  | "markers"
  | "comment";

/** Stable, layout-independent id; only [a-z0-9_.:-], max 96 chars (server regex). */
export function presenceAnchor(
  kind: AnchorKind,
  ...parts: (string | number)[]
): string {
  const clean = parts.map((p) =>
    String(p)
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "-"),
  );
  return [kind, ...clean].join(":").slice(0, 96);
}

export function transcriptWordPresenceAnchor(
  trackId: string,
  sourceId: string | null,
  wordIndex: number,
): string {
  const identity = JSON.stringify([trackId, sourceId, wordIndex]);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < identity.length; i += 1) {
    hash ^= BigInt(identity.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return presenceAnchor(
    "transcript",
    "word",
    hash.toString(16).padStart(16, "0"),
  );
}

export function presenceAnchorProps(id: string): Record<string, string> {
  return { [PRESENCE_ANCHOR_ATTR]: id };
}

export function findPresenceAnchor(
  target: EventTarget | null,
): { id: string; el: HTMLElement } | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const el = target.closest<HTMLElement>(`[${PRESENCE_ANCHOR_ATTR}]`);
  const id = el?.getAttribute(PRESENCE_ANCHOR_ATTR);
  return el && id ? { id, el } : null;
}

export function resolvePresenceAnchor(
  root: ParentNode,
  id: string,
): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    `[${PRESENCE_ANCHOR_ATTR}="${CSS.escape(id)}"]`,
  );
}

/** Fractions of the element rect; clamped to 0..1. */
export function anchorFractions(
  el: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  const clamp = (v: number) =>
    Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  return {
    x: clamp(r.width > 0 ? (clientX - r.left) / r.width : 0),
    y: clamp(r.height > 0 ? (clientY - r.top) / r.height : 0),
  };
}
