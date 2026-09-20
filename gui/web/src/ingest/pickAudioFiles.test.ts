import { afterEach, describe, expect, it, vi } from "vitest";
import { pickAudioFiles } from "./ingestFiles";

describe("pickAudioFiles", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function startPicker(): {
    promise: Promise<File[]>;
    input: HTMLInputElement;
  } {
    const inputs: HTMLInputElement[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
    ) => {
      const el = create(tagName);
      if (tagName.toLowerCase() === "input") {
        const input = el as HTMLInputElement;
        vi.spyOn(input, "click").mockImplementation(() => {});
        inputs.push(input);
      }
      return el;
    }) as typeof document.createElement);
    const promise = pickAudioFiles(false);
    const input = inputs[0];
    if (!input) {
      throw new Error("expected file input");
    }
    return { promise, input };
  }

  it("keeps files already on the input when window focuses before change", async () => {
    vi.useFakeTimers();
    const { promise, input } = startPicker();
    const file = new File(["wav"], "take.wav", { type: "audio/wav" });
    Object.defineProperty(input, "files", {
      configurable: true,
      get: () => [file] as unknown as FileList,
    });
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(300);
    const picked = await promise;
    expect(picked).toHaveLength(1);
    expect(picked[0]?.name).toBe("take.wav");
  });

  it("resolves empty on focus when the picker was cancelled", async () => {
    vi.useFakeTimers();
    const { promise } = startPicker();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(300);
    await expect(promise).resolves.toEqual([]);
  });
});
