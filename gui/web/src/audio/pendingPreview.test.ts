import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostFetch } from "../api/documentTransport";
import { useDawStore } from "../state/dawStore";
import { minimalProject, pendingEditView, wavResponse } from "../test/fixtures";
import { parsePendingAuditionSpan, playPendingPreview } from "./pendingPreview";

vi.mock("../api/documentTransport", () => ({ hostFetch: vi.fn() }));

const PATH = "/tmp/audition-span.json";

const SPAN_HEADERS = {
  "X-Preview-Edit-Id": "cut1",
  "X-Preview-Mode": "current",
  "X-Preview-Pad-Sec": "3",
  "X-Preview-Start-Sec": "1",
  "X-Preview-End-Sec": "6.6",
  "X-Preview-Edit-Start-Sec": "3",
  "X-Preview-Edit-End-Sec": "3.6",
};

function withHeaders(response: Response, headers: Record<string, string>) {
  return new Response(response.body, { status: 200, headers });
}

describe("parsePendingAuditionSpan", () => {
  it("reads where the file sits and where the edit is", () => {
    expect(parsePendingAuditionSpan(new Headers(SPAN_HEADERS))).toEqual({
      editId: "cut1",
      padSec: 3,
      startSec: 1,
      endSec: 6.6,
      editStartSec: 3,
      editEndSec: 3.6,
    });
  });

  it("throws naming the missing header", () => {
    expect(() => parsePendingAuditionSpan(new Headers())).toThrow(
      /X-Preview-Edit-Id/,
    );
  });

  it.each(["abc", "", "Infinity"])("throws for a value of %j", (value) => {
    expect(() =>
      parsePendingAuditionSpan(
        new Headers({ ...SPAN_HEADERS, "X-Preview-End-Sec": value }),
      ),
    ).toThrow(/X-Preview-End-Sec/);
  });
});

describe("playPendingPreview placement", () => {
  beforeEach(() => {
    vi.mocked(hostFetch).mockReset();
    useDawStore.setState({ guestMode: null });
    useDawStore
      .getState()
      .hydrate(
        PATH,
        minimalProject({ pending_edits: [pendingEditView({ id: "cut1" })] }),
      );
    URL.createObjectURL = vi.fn(() => "blob:audition");
    URL.revokeObjectURL = vi.fn();
  });

  async function play(
    headers: Record<string, string>,
    startAtEdit: boolean,
    seconds = 8,
  ) {
    vi.mocked(hostFetch).mockImplementation(async () =>
      withHeaders(wavResponse(seconds), headers),
    );
    const outcome = await playPendingPreview(PATH, "cut1", "current", {
      padSec: 3,
      startAtEdit,
    });
    expect(outcome).toEqual({ status: "ok" });
    return useDawStore.getState().sourcePreview;
  }

  it("starts at the edit inside the file when asked", async () => {
    const preview = await play(SPAN_HEADERS, true);
    expect(preview?.startSec).toBe(2);
    expect(preview?.endSec).toBeCloseTo(8, 1);
  });

  it("starts at the file start when not asked", async () => {
    expect((await play(SPAN_HEADERS, false))?.startSec).toBe(0);
  });

  it("falls back to the file start without the headers", async () => {
    expect((await play({}, true))?.startSec).toBe(0);
  });

  it("falls back to the file start when the edit is outside the file", async () => {
    const preview = await play(
      { ...SPAN_HEADERS, "X-Preview-Edit-Start-Sec": "99" },
      true,
    );
    expect(preview?.startSec).toBe(0);
  });
});
