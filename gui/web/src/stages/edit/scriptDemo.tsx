import {
  type CSSProperties,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ScriptPaneProps } from "../../system/ScriptPane";
import type { ScriptSelection } from "../../system/scriptPieces";

/** A stage-sized column the pane can scroll in. */
export const scriptFrame = (width: string): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  inlineSize: width,
  maxInlineSize: "100%",
  blockSize: "36rem",
  maxBlockSize: "100dvh",
  border: "1px solid var(--color-border)",
});

/**
 * Selection and caret that follow the pane's intents, over the callbacks a
 * story spies on, so Shift+Arrow, the handles and Esc all move something.
 */
export function useLiveScript(base: ScriptPaneProps) {
  const [selection, setSelection] = useState<ScriptSelection | null>(
    base.selection ?? null,
  );
  const [caret, setCaret] = useState<number | undefined>(undefined);
  const pane: ScriptPaneProps = {
    ...base,
    selection,
    carets:
      caret === undefined
        ? base.carets
        : [{ before: caret }, ...(base.carets ?? []).filter((c) => c.person)],
    onCaret: (before) => {
      base.onCaret?.(before);
      setCaret(before);
      setSelection(null);
    },
    onSelect: (next) => {
      base.onSelect?.(next);
      setSelection(next);
    },
    onSeamSelect: (id) => {
      base.onSeamSelect?.(id);
      setSelection({ kind: "cut", id });
    },
    onSuggestionSelect: (id) => {
      base.onSuggestionSelect?.(id);
      setSelection({ kind: "suggestion", id });
    },
    onClearSelection: () => {
      base.onClearSelection?.();
      setSelection(null);
    },
  };
  return { pane, selection, setSelection };
}

/** The first selected element of the host, for a floating bar to sit on; follows the selection. */
export function useSelectionAnchor(
  selection: ScriptSelection | null,
  hidden = false,
): [RefObject<HTMLDivElement | null>, RefObject<HTMLElement | null> | null] {
  const host = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<RefObject<HTMLElement | null> | null>(
    null,
  );
  useLayoutEffect(() => {
    const target =
      hidden || selection === null
        ? null
        : (host.current?.querySelector<HTMLElement>("[data-selected]") ?? null);
    setAnchor(target ? { current: target } : null);
  }, [selection, hidden]);
  return [host, anchor];
}
