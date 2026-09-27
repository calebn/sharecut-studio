import { useEffect, useId, useRef, useState } from "react";
import { useProjectMutation } from "../hooks/useProjectMutation";
import { InlineError } from "../ui/InlineError";
import { submitWordCorrection, wordCorrectionError } from "./wordCorrection";

interface Props {
  trackId: string;
  wordIndex: number;
  initialText: string;
  onClose: (restoreFocus: boolean) => void;
  /** True when a commit starts, false once it settles (also after unmount). */
  onBusyChange?: (busy: boolean) => void;
}

/** In-place word text fix: Enter commits (one undo step), Esc / blur cancel. */
export function InlineWordEditor({
  trackId,
  wordIndex,
  initialText,
  onClose,
  onBusyChange,
}: Props) {
  const { busy, error, setError, run, projectPath } = useProjectMutation();
  const [text, setText] = useState(initialText);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busyRef = useRef(false);
  const errorId = useId();

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
    const ok = await run(async () => {
      await submitWordCorrection(
        projectPath,
        trackId,
        wordIndex,
        wordIndex,
        text,
      );
      return true;
    });
    busyRef.current = false;
    onBusyChange?.(false);
    if (ok) onClose(true);
    else inputRef.current?.focus();
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
