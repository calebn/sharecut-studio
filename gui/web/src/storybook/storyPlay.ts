/** Wraps a play function so the autodocs previews, which render many stories at once, skip it. */
export const playInCanvas =
  <Context extends { viewMode?: string }>(
    run: (context: Context) => Promise<void>,
  ) =>
  async (context: Context) => {
    if (context.viewMode === "docs") return;
    await run(context);
  };

/** A real DataTransfer carrying `files`, which real browsers require on DragEvents. */
export const fileDataTransfer = (files: File[]): DataTransfer => {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  return dataTransfer;
};

/** Dispatches a real, bubbling DragEvent carrying `dataTransfer` (testing-library would copy it into a plain object). */
export const fireDrag = (
  target: Element,
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  dataTransfer: DataTransfer,
): void => {
  target.dispatchEvent(
    new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }),
  );
};
