import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyKit,
  type KitOffer,
  loadKitOffer,
  loadSegments,
  undoHistory,
} from "../../api";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import { ApiError } from "../../utils/apiError";
import { FrameAlerts } from "./FrameAlerts";
import { KitOfferNotice } from "./KitOfferNotice";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  loadKitOffer: vi.fn(),
  applyKit: vi.fn(),
  loadSegments: vi.fn(),
  undoHistory: vi.fn(),
}));
vi.mock("../../document/applyDocumentUpdate", () => ({
  refreshDocumentProject: vi.fn().mockResolvedValue(undefined),
}));

const PATH = "/tmp/test/episode.sharecut";
const offer: KitOffer = {
  offer: true,
  reason: "offer",
  unusable: [],
  kits: [
    {
      id: "show-1",
      name: "Show Kit",
      version: 2,
      entries: [
        { segment_id: "intro-1", version: 1, at: "start", note: null },
        { segment_id: "outro-1", version: 1, at: "end", note: null },
      ],
    },
  ],
};
const report = {
  kit_id: "show-1",
  kit_version: 2,
  timeline_duration_before_sec: 8,
  timeline_duration_after_sec: 12,
  dry_run: false,
  entries: [],
  undo_steps: 2,
  history_head_id: "h2",
};

const toast = () => useDawStore.getState().feedbackToast;

function mount(guestShare = false) {
  return render(
    <FrameAlerts>
      <KitOfferNotice guestShare={guestShare} />
    </FrameAlerts>,
  );
}

function openProject(clipCount = 3) {
  useDawStore.setState({
    projectPath: PATH,
    projectEpoch: 1,
    guestMode: null,
    project: minimalProject({
      clips: { tracks: {}, clip_count: clipCount },
    }),
    feedbackToast: null,
  });
}

const add = () => screen.findByRole("button", { name: "Add them" });

beforeEach(() => {
  localStorage.clear();
  openProject();
  vi.mocked(loadKitOffer).mockResolvedValue(offer);
  vi.mocked(loadSegments).mockResolvedValue([
    { id: "intro-1", name: "Warm Intro" },
    { id: "outro-1", name: "Sign Off" },
  ] as never);
  vi.mocked(applyKit).mockResolvedValue(report);
  vi.mocked(undoHistory).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("KitOfferNotice", () => {
  it("offers the kit with its entries named from the library", async () => {
    mount();
    expect(
      await screen.findByText("Add your show's intro and outro?"),
    ).toBeTruthy();
    expect(
      screen.getByText("Warm Intro at start, Sign Off at end"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    expect(applyKit).not.toHaveBeenCalled();
  });

  it("names a segment the library no longer lists generically", async () => {
    vi.mocked(loadSegments).mockRejectedValue(new Error("down"));
    mount();
    expect(
      await screen.findByText("A segment at start, A segment at end"),
    ).toBeTruthy();
  });

  it("is hidden for a share guest and never asks the server", async () => {
    mount(true);
    await act(async () => {});
    expect(screen.queryByText("Add your show's intro and outro?")).toBeNull();
    expect(loadKitOffer).not.toHaveBeenCalled();
  });

  it("is hidden when the viewer is a guest by session", async () => {
    useDawStore.setState({ guestMode: "review" });
    mount();
    await act(async () => {});
    expect(loadKitOffer).not.toHaveBeenCalled();
  });

  it("is hidden when the reason is not offer", async () => {
    vi.mocked(loadKitOffer).mockResolvedValue({
      offer: false,
      reason: "already_has_segments",
      kits: [],
      unusable: [],
    });
    mount();
    await waitFor(() => expect(loadKitOffer).toHaveBeenCalled());
    expect(screen.queryByText("Add your show's intro and outro?")).toBeNull();
  });

  it("is hidden when the offer cannot be read", async () => {
    vi.mocked(loadKitOffer).mockRejectedValue(new Error("offline"));
    mount();
    await waitFor(() => expect(loadKitOffer).toHaveBeenCalled());
    expect(screen.queryByText("Add your show's intro and outro?")).toBeNull();
  });

  it("applies the offered version on the tap, then says what went in with Undo", async () => {
    vi.mocked(loadKitOffer)
      .mockResolvedValueOnce(offer)
      .mockResolvedValue({
        ...offer,
        offer: false,
        reason: "already_has_segments",
        kits: [],
      });
    mount();
    await userEvent.click(await add());
    await waitFor(() =>
      expect(toast()?.message).toBe(
        "Added Warm Intro and Sign Off. Undo takes back both.",
      ),
    );
    expect(applyKit).toHaveBeenCalledWith(
      PATH,
      expect.objectContaining({ id: "show-1", version: 2 }),
    );
    expect(toast()?.reverse).not.toBeNull();
    await waitFor(() =>
      expect(screen.queryByText("Add your show's intro and outro?")).toBeNull(),
    );
    expect(loadKitOffer).toHaveBeenCalledTimes(2);
  });

  it("applies once however many times Add them is tapped", async () => {
    let finish: (value: typeof report) => void = () => {};
    vi.mocked(applyKit).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    const button = await add();
    await userEvent.dblClick(button);
    expect(applyKit).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("Adding your intro and outro…"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add them" })).toBeNull();
    await act(async () => finish(report));
  });

  it("keeps the offer after a failure, says why, and reads the offer again", async () => {
    vi.mocked(applyKit).mockRejectedValue(
      new ApiError("The show kit changed.", "kit_changed", 409),
    );
    mount();
    await userEvent.click(await add());
    await waitFor(() => expect(toast()?.tone).toBe("error"));
    expect(toast()?.message).toContain("The show kit changed.");
    expect(loadKitOffer).toHaveBeenCalledTimes(2);
    expect(await add()).toBeTruthy();
  });

  it("shows a partial failure's message and lets the next read decide", async () => {
    vi.mocked(applyKit).mockRejectedValue(
      new ApiError(
        "Kit entry 2 of 2 (Sign Off) failed. 1 earlier entry was already applied.",
        "project_write_failed",
        500,
      ),
    );
    vi.mocked(loadKitOffer)
      .mockResolvedValueOnce(offer)
      .mockResolvedValue({
        ...offer,
        offer: false,
        reason: "already_has_segments",
        kits: [],
      });
    mount();
    await userEvent.click(await add());
    await waitFor(() => expect(toast()?.tone).toBe("error"));
    expect(toast()?.message).toContain("1 earlier entry was already applied");
    await waitFor(() =>
      expect(screen.queryByText("Add your show's intro and outro?")).toBeNull(),
    );
  });

  async function applied() {
    mount();
    await userEvent.click(await add());
    await waitFor(() => expect(toast()?.reverse).toBeTruthy());
    const reverse = toast()?.reverse;
    if (!reverse) throw new Error("no undo on the toast");
    return reverse;
  }

  it("undoes each entry with the head the one before left", async () => {
    vi.mocked(undoHistory)
      .mockResolvedValueOnce("h1" as never)
      .mockResolvedValueOnce("h0" as never);
    const reverse = await applied();
    expect(await reverse.run()).toBe(true);
    expect(reverse.done).toBe("Took back your intro and outro.");
    expect(
      vi.mocked(undoHistory).mock.calls.map((c) => c[1].expectedHeadId),
    ).toEqual(["h2", "h1"]);
    await waitFor(() => expect(loadKitOffer).toHaveBeenCalledTimes(3));
  });

  it("stops at the first refusal and says how many it undid", async () => {
    vi.mocked(undoHistory)
      .mockResolvedValueOnce("h1" as never)
      .mockRejectedValueOnce(new ApiError("stale", "history_stale", 409));
    const reverse = await applied();
    expect(await reverse.run()).toBe(
      "Undid 1 of 2; the rest can't be undone because the project changed.",
    );
    expect(undoHistory).toHaveBeenCalledTimes(2);
  });

  it("undoes nothing when the first step is refused", async () => {
    vi.mocked(undoHistory).mockRejectedValue(
      new ApiError("stale", "history_stale", 409),
    );
    const reverse = await applied();
    expect(await reverse.run()).toBe(false);
    expect(undoHistory).toHaveBeenCalledTimes(1);
  });

  it("does not count a step that lands no head", async () => {
    vi.mocked(undoHistory)
      .mockResolvedValueOnce("h1" as never)
      .mockResolvedValueOnce(null);
    const reverse = await applied();
    expect(await reverse.run()).toBe(
      "Undid 1 of 2; the rest can't be undone because the project changed.",
    );
  });

  it("reports nothing undone when the first step lands no head", async () => {
    vi.mocked(undoHistory).mockResolvedValueOnce(null);
    const reverse = await applied();
    expect(await reverse.run()).toBe(false);
  });

  it("does not call a lost reply a success", async () => {
    vi.mocked(undoHistory)
      .mockResolvedValueOnce("h1" as never)
      .mockRejectedValueOnce(new Error("network"));
    const reverse = await applied();
    expect(await reverse.run()).toBe(
      "Undid 1 of 2; the rest can't be undone because the project changed.",
    );
    vi.mocked(undoHistory).mockRejectedValueOnce(new Error("network"));
    const again = await applied();
    await expect(again.run()).rejects.toThrow("network");
  });

  it("keeps the Undo toast up for 20 s", async () => {
    await applied();
    expect(toast()?.dwellMs).toBe(20000);
  });

  it("does not undo without the head the apply reported", async () => {
    vi.mocked(applyKit).mockResolvedValue({ ...report, history_head_id: null });
    const reverse = await applied();
    expect(await reverse.run()).toBe(false);
    expect(undoHistory).not.toHaveBeenCalled();
  });

  it("Not now hides it for this episode and kit, and stays hidden after a reload", async () => {
    const view = mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "Not now" }),
    );
    expect(screen.queryByText("Add your show's intro and outro?")).toBeNull();
    expect(
      localStorage.getItem(`sharecut.kitOffer.dismissed:${PATH}:show-1`),
    ).toBe("1");
    view.unmount();
    mount();
    await waitFor(() => expect(loadKitOffer).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Add your show's intro and outro?")).toBeNull();
  });

  it("still hides for this visit when storage is unavailable, and offers again next time", async () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    const view = mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "Not now" }),
    );
    expect(screen.queryByText("Add your show's intro and outro?")).toBeNull();
    view.unmount();
    mount();
    expect(
      await screen.findByText("Add your show's intro and outro?"),
    ).toBeTruthy();
    setItem.mockRestore();
    getItem.mockRestore();
  });

  it("offers a different episode again", async () => {
    localStorage.setItem(
      `sharecut.kitOffer.dismissed:/other.sharecut:show-1`,
      "1",
    );
    mount();
    expect(
      await screen.findByText("Add your show's intro and outro?"),
    ).toBeTruthy();
  });

  it("reads the offer again when the first clip arrives and when a run ends", async () => {
    openProject(0);
    mount();
    await waitFor(() => expect(loadKitOffer).toHaveBeenCalledTimes(1));
    act(() => {
      useDawStore.setState({
        project: minimalProject({ clips: { tracks: {}, clip_count: 2 } }),
      });
    });
    await waitFor(() => expect(loadKitOffer).toHaveBeenCalledTimes(2));
    act(() => {
      useDawStore.setState({
        activityJob: { id: "job-1", status: "ok", kind: "pipeline" } as never,
      });
    });
    await waitFor(() => expect(loadKitOffer).toHaveBeenCalledTimes(3));
  });

  it("leaves no Add button between the apply and the next read", async () => {
    let finish: (value: typeof report) => void = () => {};
    vi.mocked(applyKit).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let answer: (value: KitOffer) => void = () => {};
    mount();
    await userEvent.click(await add());
    vi.mocked(loadKitOffer).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await act(async () => finish(report));
    expect(screen.queryByRole("button", { name: "Add them" })).toBeNull();
    await act(async () => answer(offer));
    expect(await add()).toBeTruthy();
  });

  it("does not hold the next episode on Adding, and posts no Undo for the old one", async () => {
    let finish: (value: typeof report) => void = () => {};
    vi.mocked(applyKit).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    await userEvent.click(await add());
    act(() => {
      useDawStore.setState({
        projectPath: "/tmp/other.sharecut",
        projectEpoch: 2,
      });
    });
    expect(await add()).toBeTruthy();
    expect(screen.queryByText("Adding your intro and outro…")).toBeNull();
    await act(async () => finish(report));
    expect(toast()).toBeNull();
    expect(await add()).toBeTruthy();
  });

  it("drops an offer that was read for another project", async () => {
    let answer: (value: KitOffer) => void = () => {};
    vi.mocked(loadKitOffer).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    mount();
    act(() => {
      useDawStore.setState({
        projectPath: "/tmp/other.sharecut",
        projectEpoch: 2,
      });
    });
    await act(async () => answer(offer));
    await waitFor(() => expect(loadKitOffer).toHaveBeenCalledTimes(2));
    expect(vi.mocked(loadKitOffer).mock.calls[1][0]).toBe(
      "/tmp/other.sharecut",
    );
  });
});
