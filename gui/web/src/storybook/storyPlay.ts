/** Wraps a play function so the autodocs previews, which render many stories at once, skip it. */
export const playInCanvas =
  <Context extends { viewMode?: string }>(
    run: (context: Context) => Promise<void>,
  ) =>
  async (context: Context) => {
    if (context.viewMode === "docs") return;
    await run(context);
  };

/**
 * A DataTransfer carrying `files`. Real browsers get the real DataTransfer, which DragEvents require.
 * jsdom has none, so it gets a minimal stand-in with the members the drop code reads.
 */
export const fileDataTransfer = (files: File[]): DataTransfer => {
  if (typeof DataTransfer !== "undefined") {
    const dataTransfer = new DataTransfer();
    for (const file of files) dataTransfer.items.add(file);
    return dataTransfer;
  }
  const data = new Map<string, string>();
  const items = files.map((file) => ({
    kind: "file" as const,
    type: file.type,
    getAsFile: () => file,
  }));
  const fake = {
    dropEffect: "none",
    effectAllowed: "all",
    files,
    items,
    get types() {
      return [...(files.length > 0 ? ["Files"] : []), ...data.keys()];
    },
    setData: (format: string, value: string) => void data.set(format, value),
    getData: (format: string) => data.get(format) ?? "",
    clearData: () => data.clear(),
  };
  return fake as unknown as DataTransfer;
};

/** Dispatches a real, bubbling DragEvent carrying `dataTransfer` (testing-library would copy it into a plain object). */
export const fireDrag = (
  target: Element,
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  dataTransfer: DataTransfer,
): void => {
  if (typeof DragEvent !== "undefined" && typeof DataTransfer !== "undefined") {
    target.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }),
    );
    return;
  }
  // jsdom: no DragEvent, so a generic Event carries the transfer.
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
};
