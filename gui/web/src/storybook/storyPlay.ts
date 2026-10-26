/** Wraps a play function so the autodocs previews, which render many stories at once, skip it. */
export const playInCanvas =
  <Context extends { viewMode?: string }>(
    run: (context: Context) => Promise<void>,
  ) =>
  async (context: Context) => {
    if (context.viewMode === "docs") return;
    await run(context);
  };
