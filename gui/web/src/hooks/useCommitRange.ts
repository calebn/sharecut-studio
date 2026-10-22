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
 * unless mid-drag. A drag cancelled, backgrounded or blurred before a change event
 * returns the thumb to `saved`; a change that follows a cancel or backgrounding
 * is ignored. The listener follows the element, so a slider that mounts
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
  const uncommittedRef = useRef(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interruptedRef = useRef(false);
  const savedRef = useRef(saved);
  savedRef.current = saved;

  const cancelRevert = () => {
    if (revertTimerRef.current !== null) {
      clearTimeout(revertTimerRef.current);
      revertTimerRef.current = null;
    }
  };
  useEffect(() => cancelRevert, []);

  useEffect(() => {
    if (!draggingRef.current) {
      setValue(saved);
    }
  }, [saved]);

  const commit = (next: number) => {
    cancelRevert();
    draggingRef.current = false;
    uncommittedRef.current = false;
    if (next !== saved) {
      onCommit(next);
    }
  };
  const onNativeChange = useEffectEvent((next: number) => {
    if (interruptedRef.current || document.visibilityState === "hidden") {
      interruptDrag();
      return;
    }
    commit(next);
  });

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
  // A pointer release can report cancel or blur just before its change event, so
  // the revert waits a task for a change to claim the drag.
  const abandonDrag = () => {
    draggingRef.current = false;
    if (!uncommittedRef.current) {
      return;
    }
    cancelRevert();
    revertTimerRef.current = setTimeout(() => {
      revertTimerRef.current = null;
      if (uncommittedRef.current) {
        uncommittedRef.current = false;
        setValue(savedRef.current);
      }
    }, 0);
  };

  // The page backgrounding or the pointer being cancelled mid-drag ends it
  // without a user release; WebKit still fires a change event for it, which
  // must not commit the half-dragged value.
  const interruptDrag = () => {
    if (!uncommittedRef.current) {
      return;
    }
    cancelRevert();
    draggingRef.current = false;
    uncommittedRef.current = false;
    interruptedRef.current = true;
    setValue(savedRef.current);
  };
  const onInterrupt = useEffectEvent(interruptDrag);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        onInterrupt();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onInterrupt);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onInterrupt);
    };
  }, []);

  return {
    value,
    input,
    commitValue: (next) => {
      interruptedRef.current = false;
      setValue(next);
      commit(next);
    },
    inputProps: {
      ref: setInput,
      value,
      onChange: (e) => {
        interruptedRef.current = false;
        cancelRevert();
        draggingRef.current = true;
        uncommittedRef.current = true;
        setValue(Number(e.currentTarget.value));
      },
      onPointerUp: endDrag,
      onPointerCancel: interruptDrag,
      onBlur: abandonDrag,
    },
  };
}
