import {
  type ChangeEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

export interface CommitRangeInputProps {
  ref: (el: HTMLInputElement | null) => void;
  value: number;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onBlur: () => void;
}

export interface CommitRange {
  /** Thumb position: the saved value, or the local one mid-drag. */
  value: number;
  /** The mounted range input (null while unmounted), e.g. to focus it. */
  input: HTMLInputElement | null;
  /** Move the thumb and commit now (Reset, double-click). */
  commitValue: (value: number) => void;
  /** Spread onto the `<input type="range">`. */
  inputProps: CommitRangeInputProps;
}

/**
 * Commit-on-release range slider: the thumb moves locally while dragging and
 * each native `change` (pointer release, or an arrow-key step) commits once,
 * skipping a value equal to `saved`. It follows `saved` (undo, a collaborator)
 * unless mid-drag. The listener follows the element, so a slider that mounts
 * later still commits.
 */
export function useCommitRange({
  saved,
  onCommit,
}: {
  saved: number;
  onCommit: (value: number) => void;
}): CommitRange {
  const [value, setValue] = useState(saved);
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!draggingRef.current) {
      setValue(saved);
    }
  }, [saved]);

  const commit = (next: number) => {
    draggingRef.current = false;
    if (next !== saved) {
      onCommit(next);
    }
  };
  const onNativeChange = useEffectEvent((next: number) => commit(next));

  // React's onChange fires on every input; the native change event is the commit.
  useEffect(() => {
    if (!input) {
      return;
    }
    const onChange = () => onNativeChange(Number(input.value));
    input.addEventListener("change", onChange);
    return () => input.removeEventListener("change", onChange);
  }, [input]);

  // A drag released where it started fires no change event; stop ignoring `saved` anyway.
  const endDrag = () => {
    draggingRef.current = false;
  };

  return {
    value,
    input,
    commitValue: (next) => {
      setValue(next);
      commit(next);
    },
    inputProps: {
      ref: setInput,
      value,
      onChange: (e) => {
        draggingRef.current = true;
        setValue(Number(e.currentTarget.value));
      },
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onBlur: endDrag,
    },
  };
}
