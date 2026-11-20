let focusComposer: (() => boolean) | null = null;

export function registerComposerFocus(focus: () => boolean): () => void {
  focusComposer = focus;
  return () => {
    if (focusComposer === focus) focusComposer = null;
  };
}

export function focusComposerFromKey(): boolean {
  return focusComposer?.() ?? false;
}
