import { useEffect, useId, useRef, useState } from "react";
import { useMountedRef } from "../hooks/useMountedRef";
import { useProjectMutation } from "../hooks/useProjectMutation";
import { InlineError } from "../ui/InlineError";
import { errorMessage } from "../utils/apiError";
import { submitWordCorrection, wordCorrectionError } from "./wordCorrection";

interface Props {
  trackId: string;
  wordIndex: number;
  initialText: string;
  onClose: (restoreFocus: boolean) => void;
  /**
   * True when a commit starts, false once it settles, including after this
   * editor unmounted (mode switch, word removed). It must stay safe to call
   * then: the handler must only touch state that outlives this editor and
   * its parent panel (the panel unmounts on a tab switch), e.g. the DAW
   * store.
   */
  onBusyChange?: (busy: boolean) => void;
  /**
   * A commit that fails after this editor unmounted (mode switch, word
   * removed, editing no longer allowed) reports its message here, because
   * the editor's own inline error is gone. The handler must outlive the
   * parent panel too, e.g. write to the DAW store.
   */
  onDetachedError?: (message: string) => void;
}

/** In-place word text fix: Enter commits (one undo step), Esc / blur cancel. */
export function InlineWordEditor({
  trackId,
  wordIndex,
  initialText,
  onClose,
  onBusyChange,
  onDetachedError,
}: Props) {
  const { busy, error, setError, run, projectPath } = useProjectMutation();
  const [text, setText] = useState(initialText);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busyRef = useRef(false);
  const errorId = useId();
  const mountedRef = useMountedRef();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = async () => {
    if (busyRef.current) return;
    if (text.trim() === initialText.trim()) {
      onClose(true);
      return;
    }
    const problem = wordCorrectionError(text, wordIndex, wordIndex);
    if (problem) {
      setError(problem);
      return;
    }
    busyRef.current = true;
    onBusyChange?.(true);
    let failure: unknown;
    const ok = await run(async () => {
      try {
        await submitWordCorrection(
          projectPath,
          trackId,
          wordIndex,
          wordIndex,
          text,
        );
      } catch (e) {
        failure = e;
        throw e;
      }
      return true;
    });
    busyRef.current = false;
    onBusyChange?.(false);
    if (!mountedRef.current) {
      // Closed mid-request: nothing here to focus or show the error in.
      if (!ok) {
        onDetachedError?.(
          `Could not fix “${initialText}”: ${errorMessage(failure)}`,
        );
      }
      return;
    }
    // Leave focus wherever the user moved it while the request ran (e.g. the
    // comment composer). Only a still-focused input hands focus back to the chip.
    const hadFocus = document.activeElement === inputRef.current;
    if (ok) onClose(hadFocus);
  };

  return (
    <span className="transcript-inline-editor">
      <input
        ref={inputRef}
        type="text"
        className="transcript-inline-input"
        value={text}
        readOnly={busy}
        size={Math.max(3, text.length + 1)}
        aria-label={`Correct word “${initialText}”`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            // Like blur: a commit in flight cannot be recalled, so let it settle.
            if (!busyRef.current) onClose(true);
          }
        }}
        onBlur={() => {
          if (!busyRef.current) onClose(false);
        }}
      />
      <InlineError inline id={errorId} role="alert" message={error} />
    </span>
  );
}
