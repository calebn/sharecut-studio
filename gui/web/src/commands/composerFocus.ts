let focusComposer: (() => boolean) | null = null;

/** The Review composer registers how to focus its field while it is on screen; one at a time. */
export function registerComposerFocus(focus: () => boolean): () => void {
  focusComposer = focus;
  return () => {
    if (focusComposer === focus) focusComposer = null;
  };
}

/** Focuses the registered composer field. Returns whether it took focus. */
export function focusComposerFromKey(): boolean {
  return focusComposer?.() ?? false;
}
