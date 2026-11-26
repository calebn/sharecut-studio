import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareOrSave } from "./shareOrSave";

const FILE = { blob: new Blob(["zip"]), filename: "a.sharecutkit" };

function device(options: {
  coarse: boolean;
  canShare?: boolean;
  share?: () => Promise<void>;
}) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: options.coarse })),
  );
  Object.assign(navigator, {
    canShare:
      options.canShare === undefined ? undefined : () => options.canShare,
    share: options.share,
  });
}

let clicked: string[];

beforeEach(() => {
  clicked = [];
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this.download);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.assign(navigator, { canShare: undefined, share: undefined });
});

describe("shareOrSave", () => {
  it("shares the file on a touch device that can share it", async () => {
    const share = vi.fn(async () => {});
    device({ coarse: true, canShare: true, share });
    expect(await shareOrSave(FILE)).toEqual({ kind: "shared" });
    expect(share).toHaveBeenCalledOnce();
    expect(clicked).toEqual([]);
  });

  it("treats a closed share sheet as a cancel and saves nothing", async () => {
    device({
      coarse: true,
      canShare: true,
      share: async () => {
        throw new DOMException("closed", "AbortError");
      },
    });
    expect(await shareOrSave(FILE)).toEqual({ kind: "cancelled" });
    expect(clicked).toEqual([]);
  });

  it("downloads and says so when the share is refused", async () => {
    device({
      coarse: true,
      canShare: true,
      share: async () => {
        throw new DOMException("no gesture", "NotAllowedError");
      },
    });
    expect(await shareOrSave(FILE)).toEqual({
      kind: "downloaded",
      filename: "a.sharecutkit",
      afterShare: true,
    });
    expect(clicked).toEqual(["a.sharecutkit"]);
  });

  it("downloads without a share when the browser cannot share files", async () => {
    device({ coarse: true });
    expect(await shareOrSave(FILE)).toEqual({
      kind: "downloaded",
      filename: "a.sharecutkit",
      afterShare: false,
    });
  });

  it("downloads on a desktop even when sharing exists", async () => {
    const share = vi.fn(async () => {});
    device({ coarse: false, canShare: true, share });
    expect((await shareOrSave(FILE)).kind).toBe("downloaded");
    expect(share).not.toHaveBeenCalled();
  });

  it("revokes the object URL after a minute", async () => {
    vi.useFakeTimers();
    device({ coarse: false });
    await shareOrSave(FILE);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });
});
