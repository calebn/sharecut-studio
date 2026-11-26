import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { shareOrSave } from "./shareOrSave";

const FILE = { blob: new Blob(["zip"]), filename: "a.sharecutkit" };

function device(options: {
  coarse: boolean;
  canShare?: boolean;
  share?: (data: ShareData) => Promise<void>;
}) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: options.coarse })),
  );
  Object.assign(navigator, {
    canShare:
      options.canShare === undefined
        ? undefined
        : (data: ShareData) => canShare(data) ?? options.canShare,
    share: options.share,
  });
}

let clicked: string[];
let hrefs: string[];
let canShare: Mock<(data: ShareData) => boolean | undefined>;

beforeEach(() => {
  clicked = [];
  hrefs = [];
  canShare = vi.fn<(data: ShareData) => boolean | undefined>();
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this.download);
    hrefs.push(this.href);
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
    const [data] = share.mock.calls[0] as unknown as [{ files: File[] }];
    expect(data.files).toHaveLength(1);
    expect(data.files[0].name).toBe("a.sharecutkit");
    expect(data.files[0].type).toBe("application/zip");
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
    vi.advanceTimersByTime(59_999);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });

  it("asks canShare about, and shares, the same single file", async () => {
    const share = vi.fn(async (_data: ShareData) => {});
    device({ coarse: true, canShare: true, share });
    await shareOrSave(FILE);
    const asked = canShare.mock.calls[0][0] as { files: File[] };
    const shared = share.mock.calls[0][0];
    expect(Object.keys(shared)).toEqual(["files"]);
    expect(asked.files).toHaveLength(1);
    expect(asked.files[0].name).toBe("a.sharecutkit");
    expect(shared.files).toEqual(asked.files);
  });

  it("downloads through a hidden anchor on the object URL of the fetched file, then removes it", async () => {
    device({ coarse: false });
    await shareOrSave(FILE);
    expect(URL.createObjectURL).toHaveBeenCalledWith(FILE.blob);
    expect(hrefs).toEqual(["blob:x"]);
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
