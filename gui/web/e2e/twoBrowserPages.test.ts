import { describe, expect, it, vi } from "vitest";
import { withBrowserPages, withTwoBrowserPages } from "./twoBrowserPages";

function browserHarness(options?: {
  failContext?: number;
  failPage?: { context: number; error: Error };
  failClose?: number;
}) {
  const contexts = [0, 1].map((index) => ({
    close: vi.fn(async () => {
      if (options?.failClose === index) throw new Error(`close ${index}`);
    }),
    newPage: vi.fn(async () => {
      if (options?.failPage?.context === index) throw options.failPage.error;
      return { context: index };
    }),
  }));
  let calls = 0;
  const browser = {
    newContext: vi.fn(async () => {
      const index = calls++;
      if (options?.failContext === index) throw new Error(`context ${index}`);
      return contexts[index]!;
    }),
  };
  return { browser, contexts };
}

describe("withTwoBrowserPages", () => {
  it("closes both contexts after a successful callback", async () => {
    const { browser, contexts } = browserHarness();
    await expect(
      withTwoBrowserPages(browser as never, {}, {}, async (first, second) => {
        expect(first).toEqual({ context: 0 });
        expect(second).toEqual({ context: 1 });
        return "done";
      }),
    ).resolves.toBe("done");
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    expect(contexts[1]!.close).toHaveBeenCalledOnce();
  });

  it("closes created contexts when second context setup fails", async () => {
    const { browser, contexts } = browserHarness({ failContext: 1 });
    await expect(
      withTwoBrowserPages(browser as never, {}, {}, async () => "unreachable"),
    ).rejects.toThrow("context 1");
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    expect(contexts[1]!.close).not.toHaveBeenCalled();
  });

  it("closes both contexts when creating the second page fails", async () => {
    const pageError = new Error("second page");
    const { browser, contexts } = browserHarness({
      failPage: { context: 1, error: pageError },
    });
    await expect(
      withTwoBrowserPages(browser as never, {}, {}, async () => "unreachable"),
    ).rejects.toBe(pageError);
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    expect(contexts[1]!.close).toHaveBeenCalledOnce();
  });

  it("preserves the callback failure when cleanup also fails", async () => {
    const callbackError = new Error("scenario failed");
    const { browser, contexts } = browserHarness({ failClose: 1 });
    await expect(
      withTwoBrowserPages(browser as never, {}, {}, async () => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    expect(contexts[1]!.close).toHaveBeenCalledOnce();
  });

  it("surfaces cleanup failure after a successful callback", async () => {
    const { browser } = browserHarness({ failClose: 0 });
    await expect(
      withTwoBrowserPages(browser as never, {}, {}, async () => "done"),
    ).rejects.toThrow("close 0");
  });
});

describe("withBrowserPages", () => {
  it("closes partial setup when a later context or page fails", async () => {
    const contextFailure = browserHarness({ failContext: 1 });
    await expect(
      withBrowserPages(
        contextFailure.browser as never,
        [{}, {}],
        async () => "unreachable",
      ),
    ).rejects.toThrow("context 1");
    expect(contextFailure.contexts[0]!.close).toHaveBeenCalledOnce();

    const pageError = new Error("second page");
    const pageFailure = browserHarness({
      failPage: { context: 1, error: pageError },
    });
    await expect(
      withBrowserPages(
        pageFailure.browser as never,
        [{}, {}],
        async () => "unreachable",
      ),
    ).rejects.toBe(pageError);
    expect(pageFailure.contexts[0]!.close).toHaveBeenCalledOnce();
    expect(pageFailure.contexts[1]!.close).toHaveBeenCalledOnce();
  });
});

it.each(["page", "callback", "none"] as const)(
  "retains close failures without allowing notification failure to replace %s primary outcome",
  async (failure) => {
    const primary = new Error("literal primary failure");
    const { browser } = browserHarness({
      failClose: 0,
      ...(failure === "page"
        ? { failPage: { context: 0, error: primary } }
        : {}),
    });
    const observed: string[] = [];
    const operation = withBrowserPages(
      browser as never,
      [{}],
      async () => {
        if (failure === "callback") throw primary;
        return "completed";
      },
      (error) => {
        observed.push(String(error));
        throw new Error("literal close observer failure");
      },
    );
    if (failure === "none") await expect(operation).rejects.toThrow("close 0");
    else await expect(operation).rejects.toBe(primary);
    expect(observed).toEqual(["Error: close 0"]);
  },
);
