import {
  forwardRef,
  type KeyboardEvent,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SystemIcon } from "../../system/SystemIcon";
import {
  BUSY_REASON,
  unavailableReason,
  useDisabledReasonNote,
} from "../../ui/disabledReason";
import { InlineError } from "../../ui/InlineError";
import { findCountText, replacementOk } from "./findMatches";

/** Why Replace waits when the search has no hits. */
const NO_MATCHES_REASON = "No matches to replace. Change the search first.";
/** Why Replace waits on the replacement text (see `replacementOk`). */
const REPLACEMENT_REASON =
  "Enter replacement text with a letter or a number to replace.";

export type FindBarHandle = {
  /** Put the cursor in the Find field and select its text. */
  focus: () => void;
};

type FindReplaceProps = {
  /** The Replace row is showing. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  text: string;
  onTextChange: (text: string) => void;
  /**
   * Replace the current hit. A promise keeps the bar busy until it settles.
   * Left out, the bar offers Replace all only.
   */
  onReplace?: () => void | Promise<void>;
  /**
   * Replace every hit as one undo step. Returns how many were replaced, which
   * the host shows in its undo toast ("Replaced 12 · Undo"). A promise keeps
   * the bar busy until it settles.
   */
  onReplaceAll: () => number | Promise<number>;
};

export type FindBarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (caseSensitive: boolean) => void;
  /** How many hits the query has. */
  count: number;
  /** The current hit, counted from 0; -1 when there is none. */
  current: number;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  /** Cut every hit as one undo step. Left out, the button is not drawn. A promise keeps the bar busy until it settles. */
  onCutAll?: () => void | Promise<void>;
  /** Select every hit. Left out, the button is not drawn. */
  onSelectAll?: () => void;
  /** Left out for a reader who cannot edit: no Replace toggle and no Replace row. */
  replace?: FindReplaceProps;
  /** The host is working on a request: the fields are read only and the verbs wait. */
  busy?: boolean;
  /** Why the last request failed. A rejected `onCutAll`, `onReplace` or `onReplaceAll` shows its message here when this is left out. */
  error?: string;
  /** Longest query or replacement, in characters. The legacy panel allowed 500. */
  maxLength?: number;
  /**
   * Where focus goes when the bar closes and after Cut all or Replace all
   * have settled, because those controls disappear or go disabled. Pass
   * `() => pane.current?.focusFind()` so it lands on the pane's Find button.
   * Left out, a settled bulk verb puts focus back in the Find field.
   */
  returnFocus?: () => void;
};

const messageOf = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "That did not work. Try again.";

/**
 * Find and replace (spec CMP-FINDREPLACE), a bar under the Script header. It is
 * controlled: the host matches the query (see `findMatches`), feeds the hits to
 * the pane's `matches` and `currentMatch`, and scrolls the current one into view.
 *
 * Keys, in the Find field. Enter and Down step to the next hit, Shift+Enter
 * and Up to the previous one, Mod+Shift+Enter (Ctrl or Cmd) cuts all hits, and
 * Esc closes from anywhere in the bar. In the Replace field Enter replaces the
 * current hit, and only when the replacement has a letter or a number, as the
 * backend requires. Mod+F is not handled here: the host binds it to open the
 * bar and, when it is already open, to call the handle's `focus()`. The bar
 * takes focus when it mounts.
 *
 * The host owns the backend side: it runs the replace preview and sends its
 * `preview_token` with Replace all, shows the preview's skipped-word count, and
 * counts only `replacementChanges`. The bar has no props for these.
 *
 * The count is plain text, not a live region: the pane has the one polite
 * region, and the host passes it the same text as `findStatus`.
 */
export const FindBar = forwardRef<FindBarHandle, FindBarProps>(function FindBar(
  {
    query,
    onQueryChange,
    caseSensitive,
    onCaseSensitiveChange,
    count,
    current,
    onNext,
    onPrevious,
    onClose,
    onCutAll,
    onSelectAll,
    replace,
    busy = false,
    error,
    maxLength = 500,
    returnFocus,
  },
  ref,
) {
  const field = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const replaceId = useId();
  const countId = useId();
  const pending = useRef(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [settled, setSettled] = useState<{ n: number; bulk: boolean }>({
    n: 0,
    bulk: false,
  });
  const returnFocusRef = useRef(returnFocus);
  useLayoutEffect(() => {
    returnFocusRef.current = returnFocus;
  });
  const focus = () => {
    field.current?.focus();
    field.current?.select();
  };
  useImperativeHandle(ref, () => ({ focus }), []);
  useLayoutEffect(focus, []);

  const idle = !busy && !working;
  const replaceReady = replace !== undefined && replacementOk(replace.text);

  const run = async (action: () => unknown, bulk: boolean) => {
    if (pending.current) return;
    pending.current = true;
    setWorking(true);
    setFailure(null);
    try {
      await action();
    } catch (reason) {
      setFailure(messageOf(reason));
    } finally {
      pending.current = false;
      setWorking(false);
      setSettled((now) => ({ n: now.n + 1, bulk }));
    }
  };
  // The control that had focus may now be gone or disabled, so decide after the host's new props are in.
  // Once per settle: the host passes returnFocus as a new arrow on every render, and re-running on that would pull focus out of the Find field while the person types.
  useEffect(() => {
    if (settled.n === 0) return;
    if (settled.bulk && returnFocusRef.current) {
      returnFocusRef.current();
      return;
    }
    const active = document.activeElement;
    const lost =
      !active ||
      active === document.body ||
      !root.current?.contains(active) ||
      (active instanceof HTMLButtonElement && active.disabled);
    if (lost) focus();
  }, [settled]);

  const hits = count > 0;
  const replaceWait = !idle
    ? BUSY_REASON
    : !hits
      ? NO_MATCHES_REASON
      : !replaceReady
        ? REPLACEMENT_REASON
        : undefined;
  const { note: replaceNote, describedBy: replaceDescribedBy } =
    useDisabledReasonNote(replace?.open ? replaceWait : undefined);
  const replaceUnavailable =
    replace?.open && unavailableReason(replaceWait) !== undefined;
  const closeBar = () => {
    onClose();
    returnFocusRef.current?.();
  };
  const close = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return false;
    event.preventDefault();
    event.stopPropagation();
    closeBar();
    return true;
  };
  const cutAll = () => {
    if (hits && idle && onCutAll) void run(onCutAll, true);
  };
  const replaceOne = () => {
    if (hits && idle && replace?.onReplace && replaceReady)
      void run(replace.onReplace, false);
  };
  const replaceAll = () => {
    if (hits && idle && replace && replaceReady)
      void run(replace.onReplaceAll, true);
  };
  const onFindKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || close(event)) return;
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === "Enter" && mod && event.shiftKey) {
      event.preventDefault();
      cutAll();
    } else if (event.key === "Enter" && mod) {
      return;
    } else if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      if (hits) onPrevious();
    } else if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault();
      if (hits) onNext();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (hits) onPrevious();
    }
  };
  const onReplaceKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || close(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      replaceOne();
    }
  };
  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    close(event);
  };

  return (
    <div
      ref={root}
      className="sys-edit-find"
      role="search"
      aria-label="Find in transcript"
    >
      <div className="sys-edit-find-row">
        <div className="sys-edit-find-field">
          <input
            ref={field}
            type="text"
            role="searchbox"
            aria-label="Find"
            autoComplete="off"
            spellCheck={false}
            maxLength={maxLength}
            readOnly={!idle}
            aria-describedby={countId}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onFindKey}
          />
          <span id={countId} className="sys-edit-find-count">
            {findCountText(query, count, current)}
          </span>
        </div>
        <button
          type="button"
          className="sys-icon-btn"
          aria-label="Previous match"
          disabled={!hits}
          onClick={onPrevious}
          onKeyDown={onButtonKey}
        >
          <SystemIcon name="chevron-up" size={16} />
        </button>
        <button
          type="button"
          className="sys-icon-btn"
          aria-label="Next match"
          disabled={!hits}
          onClick={onNext}
          onKeyDown={onButtonKey}
        >
          <SystemIcon name="chevron-down" size={16} />
        </button>
        <button
          type="button"
          className="sys-icon-btn"
          aria-label="Match case"
          aria-pressed={caseSensitive}
          onClick={() => onCaseSensitiveChange(!caseSensitive)}
          onKeyDown={onButtonKey}
        >
          <span aria-hidden="true">Aa</span>
        </button>
        {replace ? (
          <button
            type="button"
            className="sys-icon-btn"
            aria-label="Show replace"
            aria-expanded={replace.open}
            aria-controls={replace.open ? replaceId : undefined}
            onClick={() => replace.onOpenChange(!replace.open)}
            onKeyDown={onButtonKey}
          >
            <SystemIcon name="replace" size={16} />
          </button>
        ) : null}
        {onSelectAll && hits ? (
          <button
            type="button"
            className="sys-text-btn sys-edit-find-all"
            onClick={onSelectAll}
            onKeyDown={onButtonKey}
          >
            Select all {count}
          </button>
        ) : null}
        {onCutAll && hits ? (
          <button
            type="button"
            className="sys-text-btn sys-edit-find-all"
            aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter"
            disabled={!idle}
            onClick={cutAll}
            onKeyDown={onButtonKey}
          >
            <SystemIcon name="scissors" size={14} />
            Cut all {count}
          </button>
        ) : null}
        <button
          type="button"
          className="sys-icon-btn"
          aria-label="Close find"
          onClick={closeBar}
          onKeyDown={onButtonKey}
        >
          <SystemIcon name="x" size={16} />
        </button>
      </div>
      {replace?.open ? (
        <div id={replaceId} className="sys-edit-find-row">
          <div className="sys-edit-find-field">
            <input
              type="text"
              aria-label="Replace with"
              autoComplete="off"
              spellCheck
              maxLength={maxLength}
              readOnly={!idle}
              value={replace.text}
              onChange={(event) => replace.onTextChange(event.target.value)}
              onKeyDown={onReplaceKey}
            />
          </div>
          {replace.onReplace ? (
            <button
              type="button"
              className="sys-text-btn"
              aria-disabled={replaceUnavailable || undefined}
              {...replaceDescribedBy}
              onClick={replaceOne}
              onKeyDown={onButtonKey}
            >
              Replace
            </button>
          ) : null}
          <button
            type="button"
            className="sys-text-btn"
            aria-label="Replace all"
            aria-disabled={replaceUnavailable || undefined}
            {...replaceDescribedBy}
            onClick={replaceAll}
            onKeyDown={onButtonKey}
          >
            All
          </button>
        </div>
      ) : null}
      {replaceNote}
      <InlineError message={error ?? failure} />
    </div>
  );
});
