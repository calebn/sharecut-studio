import { useEffect, useRef } from "react";
import { useDawStore } from "./dawStore";

/** Something a guest typed and had not sent, and what to call it. */
export type UnsentText = { label: string; text: string };

const COMMENT_LABEL = "Your comment";

const readers = new Map<symbol, { label: string; read: () => string[] }>();

/**
 * Registers a reader for a draft that lives in a component. It returns what
 * to take back: one string per unsent text, which may be empty. Readers keep
 * their registration order.
 */
function registerUnsent(label: string, read: () => string[]): () => void {
  const id = Symbol(label);
  readers.set(id, { label, read });
  return () => {
    readers.delete(id);
  };
}

/** Keeps a component's draft collectable for as long as the component is mounted. */
export function useUnsentText(label: string, text: string | string[]): void {
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
  });
  useEffect(
    () =>
      registerUnsent(label, () =>
        Array.isArray(latest.current) ? latest.current : [latest.current],
      ),
    [label],
  );
}

/**
 * Everything the guest typed and has not sent, in the order it is shown: the
 * comment composer first (its draft, or the text of a Post still in flight),
 * then the registered drafts. Blank entries are dropped; the text itself is
 * handed back exactly as typed. Call it before anything unmounts.
 */
export function collectUnsent(): UnsentText[] {
  const { composer } = useDawStore.getState();
  const found: UnsentText[] = [];
  const add = (label: string, text: string | undefined) => {
    if (text !== undefined && text.trim() !== "") found.push({ label, text });
  };
  add(COMMENT_LABEL, composer.draft?.text || composer.post?.sentText);
  for (const { label, read } of [...readers.values()]) {
    for (const text of read()) add(label, text);
  }
  return found;
}
