import { describe, expect, it, vi } from "vitest";
import { keeperContextSource, RECORDER_CONTEXT } from "./keeperContexts";
import { withBrowserPages } from "./twoBrowserPages";

function fakeBrowser(name: "chromium" | "webkit") {
  const context = { close: vi.fn(async () => {}), newPage: vi.fn() };
  const newContext = vi.fn(async () => context);
  const launchPersistentContext = vi.fn(async () => context);
  const browserType = { name: () => name, launchPersistentContext };
  const browser = { newContext, browserType: () => browserType };
  return { browser, browserType, newContext, launchPersistentContext, context };
}

describe("RECORDER_CONTEXT", () => {
  it("grants only the microphone permission", () => {
    expect(RECORDER_CONTEXT).toEqual({ permissions: ["microphone"] });
  });
});

describe("keeperContextSource", () => {
  it("returns the browser itself on Chromium", () => {
    const { browser } = fakeBrowser("chromium");
    expect(keeperContextSource(browser as never)).toBe(browser);
  });

  it("returns a persistent-context source on WebKit instead of the browser", () => {
    const { browser } = fakeBrowser("webkit");
    expect(keeperContextSource(browser as never)).not.toBe(browser);
  });

  it("launches an empty-userDataDir persistent context per newContext call on WebKit", async () => {
    const { browser, launchPersistentContext } = fakeBrowser("webkit");
    const source = keeperContextSource(browser as never);
    await source.newContext(RECORDER_CONTEXT);
    expect(launchPersistentContext).toHaveBeenCalledWith("", RECORDER_CONTEXT);
  });

  it("defaults to an empty options object on WebKit when none is passed", async () => {
    const { browser, launchPersistentContext } = fakeBrowser("webkit");
    const source = keeperContextSource(browser as never);
    await source.newContext();
    expect(launchPersistentContext).toHaveBeenCalledWith("", {});
  });

  it("drives withBrowserPages through persistent WebKit contexts and closes each one", async () => {
    const { browser, launchPersistentContext, context } = fakeBrowser("webkit");
    const source = keeperContextSource(browser as never);
    const result = await withBrowserPages(
      source,
      [RECORDER_CONTEXT, RECORDER_CONTEXT, {}],
      async (pages) => {
        expect(pages).toHaveLength(3);
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(launchPersistentContext).toHaveBeenCalledTimes(3);
    expect(launchPersistentContext).toHaveBeenNthCalledWith(
      1,
      "",
      RECORDER_CONTEXT,
    );
    expect(launchPersistentContext).toHaveBeenNthCalledWith(3, "", {});
    expect(context.close).toHaveBeenCalledTimes(3);
  });

  it("launches WebKit persistent contexts one at a time through withBrowserPages", async () => {
    const { browser, launchPersistentContext, context } = fakeBrowser("webkit");
    let inFlight = 0;
    let maxInFlight = 0;
    launchPersistentContext.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return context;
    });
    await withBrowserPages(
      keeperContextSource(browser as never),
      [RECORDER_CONTEXT, RECORDER_CONTEXT, {}],
      async () => "done",
    );
    expect(launchPersistentContext).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });
});
