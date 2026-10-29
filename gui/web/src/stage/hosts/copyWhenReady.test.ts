import { afterEach, describe, expect, it, vi } from "vitest";
import { copyWhenReady } from "./copyWhenReady";

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyWhenReady", () => {
  it("writes the text once it arrives when the browser has no ClipboardItem", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    let arrive!: (value: string) => void;
    const copying = copyWhenReady(
      new Promise<string>((resolve) => {
        arrive = resolve;
      }),
    );
    expect(writeText).not.toHaveBeenCalled();
    arrive("https://x.test/r/a");
    await copying;
    expect(writeText).toHaveBeenCalledWith("https://x.test/r/a");
  });

  it("rejects, not throws, when the browser refuses the write at once", async () => {
    class FakeItem {
      readonly items: Record<string, Promise<Blob>>;
      constructor(items: Record<string, Promise<Blob>>) {
        this.items = items;
      }
    }
    vi.stubGlobal("ClipboardItem", FakeItem);
    const write = vi.fn(() => {
      throw new Error("NotAllowedError");
    });
    setClipboard({ write, writeText: vi.fn() });
    let copying!: Promise<void>;
    expect(() => {
      copying = copyWhenReady(Promise.resolve("https://x.test/r/a"));
    }).not.toThrow();
    await expect(copying).rejects.toThrow("NotAllowedError");
  });

  it("starts the write inside the click, before the text exists, with ClipboardItem", async () => {
    class FakeItem {
      readonly items: Record<string, Promise<Blob>>;
      constructor(items: Record<string, Promise<Blob>>) {
        this.items = items;
      }
    }
    vi.stubGlobal("ClipboardItem", FakeItem);
    const write = vi.fn().mockResolvedValue(undefined);
    setClipboard({ write, writeText: vi.fn() });
    let arrive!: (value: string) => void;
    const copying = copyWhenReady(
      new Promise<string>((resolve) => {
        arrive = resolve;
      }),
    );
    expect(write).toHaveBeenCalledOnce();
    const item = write.mock.calls[0][0][0] as FakeItem;
    arrive("https://x.test/r/a");
    await copying;
    expect(await (await item.items["text/plain"]).text()).toBe(
      "https://x.test/r/a",
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("rejects when the text never comes", async () => {
    setClipboard({ writeText: vi.fn() });
    await expect(
      copyWhenReady(Promise.reject(new Error("mint failed"))),
    ).rejects.toThrow("mint failed");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("rejects when the browser refuses the write", async () => {
    class FakeItem {
      readonly items: Record<string, Promise<Blob>>;
      constructor(items: Record<string, Promise<Blob>>) {
        this.items = items;
      }
    }
    vi.stubGlobal("ClipboardItem", FakeItem);
    setClipboard({
      write: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
    });
    await expect(copyWhenReady(Promise.resolve("x"))).rejects.toThrow(
      "NotAllowedError",
    );
  });

  it("reports an unavailable clipboard", async () => {
    setClipboard(undefined);
    await expect(copyWhenReady(Promise.resolve("x"))).rejects.toThrow(
      "Clipboard unavailable",
    );
  });
});
