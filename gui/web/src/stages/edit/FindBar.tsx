import {
  forwardRef,
  type KeyboardEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { SystemIcon } from "../../system/SystemIcon";
import { findCountText } from "./findMatches";

export type FindBarHandle = {
  /** Put the cursor in the Find field and select its text. */
  focus: () => void;
};

export type FindReplaceProps = {
  /** The Replace row is showing. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  text: string;
  onTextChange: (text: string) => void;
  /** Replace the current hit. */
  onReplace: () => void;
  /** Replace every hit as one undo step. */
  onReplaceAll: () => void;
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
  /** Cut every hit as one undo step. Left out, the button is not drawn. */
  onCutAll?: () => void;
  /** Select every hit. Left out, the button is not drawn. */
  onSelectAll?: () => void;
  /** Left out for a reader who cannot edit: no Replace toggle and no Replace row. */
  replace?: FindReplaceProps;
};

/**
 * Find and replace (spec CMP-FINDREPLACE), a bar under the Script header. It is
 * controlled: the host matches the query (see `findMatches`), feeds the hits to
 * the pane's `matches` and `currentMatch`, and scrolls the current one into view.
 *
 * Keys. Enter and Down step to the next hit, Up to the previous one,
 * Shift+Enter cuts all hits, and Esc closes from anywhere in the bar. In the
 * Replace field Enter replaces the current hit. Mod+F is not handled here: the
 * host binds it to open the bar and, when it is already open, to call the
 * handle's `focus()`. The bar takes focus when it mounts.
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
  },
  ref,
) {
  const field = useRef<HTMLInputElement>(null);
  const replaceId = useId();
  const focus = () => {
    field.current?.focus();
    field.current?.select();
  };
  useImperativeHandle(ref, () => ({ focus }), []);
  useLayoutEffect(focus, []);

  const hits = count > 0;
  const close = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return false;
    event.preventDefault();
    event.stopPropagation();
    onClose();
    return true;
  };
  const onFindKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || close(event)) return;
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      if (hits) onCutAll?.();
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
      if (hits) replace?.onReplace();
    }
  };
  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    close(event);
  };

  return (
    <div
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
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onFindKey}
          />
          <span className="sys-edit-find-count" role="status">
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
            aria-controls={replaceId}
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
            onClick={onCutAll}
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
          onClick={onClose}
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
              value={replace.text}
              onChange={(event) => replace.onTextChange(event.target.value)}
              onKeyDown={onReplaceKey}
            />
          </div>
          <button
            type="button"
            className="sys-text-btn"
            disabled={!hits}
            onClick={replace.onReplace}
            onKeyDown={onButtonKey}
          >
            Replace
          </button>
          <button
            type="button"
            className="sys-text-btn"
            aria-label="Replace all"
            disabled={!hits}
            onClick={replace.onReplaceAll}
            onKeyDown={onButtonKey}
          >
            All
          </button>
        </div>
      ) : null}
    </div>
  );
});
