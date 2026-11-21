import { useEffect, useRef } from "react";
import { useDawStore } from "./dawStore";
import { loadOutbox, loadReturnedPosts } from "./outboxStore";

/** Something a guest typed and had not sent, and what to call it. */
export type UnsentText = { label: string; text: string };

const COMMENT_LABEL = "Your comment";

type Reader = { label: string; read: () => string[] };

const readers = new Set<Reader>();

/**
 * Keeps a component's draft collectable for as long as the component is
 * mounted. `text` may be several drafts; each non-blank one is its own entry.
 * Readers keep their registration order.
 */
export function useUnsentText(label: string, text: string | string[]): void {
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
  });
  useEffect(() => {
    const reader: Reader = {
      label,
      read: () =>
        Array.isArray(latest.current) ? latest.current : [latest.current],
    };
    readers.add(reader);
    return () => {
      readers.delete(reader);
    };
  }, [label]);
}

export async function collectKeptPosts(token: string): Promise<UnsentText[]> {
  try {
    const [waiting, refused] = await Promise.all([
      loadOutbox(token),
      loadReturnedPosts(token),
    ]);
    return [...waiting, ...refused].map((row) => ({
      label: row.kind === "reply" ? "Your reply" : COMMENT_LABEL,
      text: row.body,
    }));
  } catch {
    return [];
  }
}

/**
 * Everything the guest typed and has not sent, in the order it is shown: the
 * comment composer first (its draft, or the text of a Post still in flight),
 * then the registered drafts, then `kept`, the words this device is holding.
 * Blank entries are dropped; the text itself is handed back exactly as typed.
 * Call it before anything unmounts.
 */
export function collectUnsent(kept: readonly UnsentText[] = []): UnsentText[] {
  const { composer } = useDawStore.getState();
  const found: UnsentText[] = [];
  const add = (label: string, text: string | undefined) => {
    if (text !== undefined && text.trim() !== "") found.push({ label, text });
  };
  add(COMMENT_LABEL, composer.draft?.text || composer.post?.sentText);
  for (const { label, read } of readers) {
    for (const text of read()) add(label, text);
  }
  for (const { label, text } of kept) add(label, text);
  return found;
}
