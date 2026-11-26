import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SegmentInsertPreview, SegmentListRow } from "../../api";
import {
  DAMAGED,
  HEALTHY,
  insertPreview,
  LIBRARY,
  MULTI_VERSION,
  PLACEMENT_LIBRARY,
  segment,
} from "../../segments/fixtures";
import { expectNoA11yViolations } from "../../test/a11y";
import { ApiError } from "../../utils/apiError";
import {
  INSERT_EMPTY_LIBRARY,
  InsertSegmentCard,
  type InsertSegmentCardProps,
} from "./InsertSegmentCard";

afterEach(() => vi.unstubAllGlobals());

const crampedScreen = () => vi.stubGlobal("innerHeight", 300);

type Handlers = Pick<
  InsertSegmentCardProps,
  "loadPreview" | "onInsert" | "onClose"
>;

const handlersOf = (over: Partial<Handlers> = {}): Handlers => ({
  loadPreview: vi.fn((request) =>
    Promise.resolve(
      insertPreview({
        segment_id: request.segment_id,
        at: typeof request.at === "number" ? request.at : 0,
      }),
    ),
  ),
  onInsert: vi.fn().mockResolvedValue(undefined),
  onClose: vi.fn(),
  ...over,
});

const data = (rows: readonly SegmentListRow[] | null = LIBRARY) => ({
  rows,
  loadError: null,
  onRetryLoad: vi.fn(),
  playheadSec: 42,
  timelineEnd: 600,
});

function Anchored({
  handlers,
  rows,
}: {
  handlers: Handlers;
  rows?: readonly SegmentListRow[] | null;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button ref={anchor} type="button">
        Action bar
      </button>
      <InsertSegmentCard
        {...data(rows)}
        {...handlers}
        onClose={() => {
          handlers.onClose();
          setOpen(false);
        }}
        anchorRef={anchor}
        open={open}
      />
    </>
  );
}

const pick = (name: RegExp | string) =>
  userEvent.click(screen.getByRole("radio", { name }));

const insertButton = () => screen.getByRole("button", { name: "Insert" });

describe("InsertSegmentCard anchored", () => {
  it("lists the library, focuses the list and has no a11y violations", async () => {
    const { baseElement } = render(<Anchored handlers={handlersOf()} />);
    const first = await screen.findByRole("radio", { name: /Cold open/ });
    await waitFor(() => expect(first).toHaveFocus());
    expect(
      screen.getByRole("radio", { name: /Acme sponsor read/ }),
    ).toBeVisible();
    const damaged = screen.getByRole("radio", { name: /outro-77de/ });
    expect(damaged).toBeDisabled();
    expect(screen.getByText(/no readable audio/)).toBeVisible();
    expect(insertButton()).toBeDisabled();
    await expectNoA11yViolations(baseElement);
  });

  it("says the library is empty in plain text", async () => {
    render(<Anchored handlers={handlersOf()} rows={[]} />);
    expect(await screen.findByText(INSERT_EMPTY_LIBRARY)).toBeVisible();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("previews on a pick and defaults the position from the kind", async () => {
    const handlers = handlersOf();
    render(<Anchored handlers={handlers} />);
    await pick(/Cold open/);
    const position = screen.getByRole("combobox", { name: "Position" });
    expect(position).toHaveValue("start");
    expect(await screen.findByText("Adds 0:22 at 0:00.")).toBeVisible();
    expect(screen.getByText("Moves 4 clips later by 0:22.")).toBeVisible();
    expect(screen.getByText(/Preview, from the saved episode/)).toBeVisible();
    expect(handlers.loadPreview).toHaveBeenLastCalledWith(
      { segment_id: "intro-9f3a", at: "start" },
      expect.any(AbortSignal),
    );
    await pick(/Acme sponsor read/);
    expect(position).toHaveValue("playhead");
    await waitFor(() =>
      expect(handlers.loadPreview).toHaveBeenLastCalledWith(
        { segment_id: "sponsor-21bc", at: 42 },
        expect.any(AbortSignal),
      ),
    );
  });

  it("defaults an outro to the end and keeps a position the person chose", async () => {
    const outro = segment({ id: "out-1", name: "Sign off", kind: "outro" });
    const handlers = handlersOf();
    render(<Anchored handlers={handlers} rows={[outro, HEALTHY]} />);
    await pick(/Sign off/);
    const position = screen.getByRole("combobox", { name: "Position" });
    expect(position).toHaveValue("end");
    await userEvent.selectOptions(position, "playhead");
    await pick(/Cold open/);
    expect(position).toHaveValue("playhead");
  });

  it("sends the end when the playhead is past the timeline", async () => {
    const handlers = handlersOf();
    render(
      <InsertSegmentCard
        {...data()}
        playheadSec={900}
        {...handlers}
        form="bottom"
        open
      />,
    );
    await pick(/Acme sponsor read/);
    await waitFor(() =>
      expect(handlers.loadPreview).toHaveBeenLastCalledWith(
        { segment_id: "sponsor-21bc", at: "end" },
        expect.any(AbortSignal),
      ),
    );
  });

  it("sends the end when the playhead rounds up to the timeline end", async () => {
    const handlers = handlersOf();
    render(
      <InsertSegmentCard
        {...data()}
        playheadSec={9.9996}
        timelineEnd={10}
        {...handlers}
        form="bottom"
        open
      />,
    );
    await pick(/Acme sponsor read/);
    await waitFor(() =>
      expect(handlers.loadPreview).toHaveBeenLastCalledWith(
        { segment_id: "sponsor-21bc", at: "end" },
        expect.any(AbortSignal),
      ),
    );
  });

  it("words moved chapters, comments, pending edits and a new lane", async () => {
    const handlers = handlersOf({
      loadPreview: vi.fn().mockResolvedValue(
        insertPreview({
          clips_moved: 0,
          chapters_moved: [{ title: "Intro", from: 0, to: 22 }],
          comments_moved: [
            { id: "c1", from: 1, to: 23 },
            { id: "c2", from: 2, to: 24 },
          ],
          pending_edits_moved: 3,
          tracks_added: ["trk_9"],
        }),
      ),
    });
    render(<Anchored handlers={handlers} />);
    await pick(/Cold open/);
    expect(await screen.findByText("1 chapter moves later.")).toBeVisible();
    expect(screen.queryByText("Nothing moves.")).toBeNull();
    expect(screen.getByText("2 comments move later.")).toBeVisible();
    expect(screen.getByText("3 pending edits move later.")).toBeVisible();
    expect(screen.getByText("Adds a new lane.")).toBeVisible();
    expect(screen.queryByText(/trk_9/)).toBeNull();
    expect(screen.getByText("The episode becomes 10:22 long.")).toBeVisible();
  });

  it("says nothing moves only when nothing moves", async () => {
    const handlers = handlersOf({
      loadPreview: vi.fn().mockResolvedValue(
        insertPreview({
          clips_moved: 0,
          chapters_moved: [],
          comments_moved: [],
          pending_edits_moved: 0,
        }),
      ),
    });
    render(<Anchored handlers={handlers} />);
    await pick(/Cold open/);
    expect(await screen.findByText("Nothing moves.")).toBeVisible();
  });

  it("keeps Insert off until the current preview is back and drops a late reply", async () => {
    const pending: {
      resolve: (value: SegmentInsertPreview) => void;
      signal: AbortSignal;
      id: string;
    }[] = [];
    const handlers = handlersOf({
      loadPreview: vi.fn(
        (request, signal) =>
          new Promise<SegmentInsertPreview>((resolve) => {
            pending.push({ resolve, signal, id: request.segment_id });
          }),
      ),
    });
    render(<Anchored handlers={handlers} />);
    await pick(/Cold open/);
    expect(insertButton()).toBeDisabled();
    await pick(/Acme sponsor read/);
    expect(pending).toHaveLength(2);
    expect(pending[0]!.signal.aborted).toBe(true);
    await act(async () =>
      pending[0]!.resolve(insertPreview({ duration_sec: 99, at: 0 })),
    );
    expect(screen.queryByText(/Adds 1:39/)).toBeNull();
    expect(insertButton()).toBeDisabled();
    await act(async () =>
      pending[1]!.resolve(
        insertPreview({ segment_id: "sponsor-21bc", duration_sec: 35, at: 42 }),
      ),
    );
    expect(await screen.findByText("Adds 0:35 at 0:42.")).toBeVisible();
    expect(insertButton()).toBeEnabled();
  });

  it("explains a failed preview and offers Try again", async () => {
    const loadPreview = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("raw", "segment_unreadable", 400))
      .mockResolvedValue(insertPreview());
    render(<Anchored handlers={handlersOf({ loadPreview })} />);
    await pick(/Cold open/);
    expect(await screen.findByText(/cannot be read/)).toBeVisible();
    expect(insertButton()).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Adds 0:22 at 0:00.")).toBeVisible();
  });

  it("inserts the picked segment at the previewed version, then closes", async () => {
    const handlers = handlersOf({
      loadPreview: vi
        .fn()
        .mockResolvedValue(
          insertPreview({ segment_id: "sponsor-21bc", segment_version: 3 }),
        ),
    });
    render(<Anchored handlers={handlers} />);
    await pick(/Acme sponsor read/);
    await screen.findByText(/Preview, from the saved episode/);
    await userEvent.click(insertButton());
    expect(handlers.onInsert).toHaveBeenCalledWith({
      name: "Acme sponsor read",
      request: { segment_id: "sponsor-21bc", at: 42, version: 3 },
    });
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalledTimes(1));
  });

  it("ignores a second press while inserting", async () => {
    let finish!: () => void;
    const onInsert = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const handlers = handlersOf({ onInsert });
    render(<Anchored handlers={handlers} />);
    await pick(/Cold open/);
    await screen.findByText(/Preview, from the saved episode/);
    const form = insertButton().closest("form")!;
    act(() => {
      form.requestSubmit();
      form.requestSubmit();
    });
    expect(onInsert).toHaveBeenCalledTimes(1);
    await userEvent.click(insertButton());
    expect(onInsert).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalledTimes(1));
  });

  it("stays open on Escape and Cancel while inserting", async () => {
    let fail!: (error: unknown) => void;
    const onInsert = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const handlers = handlersOf({ onInsert });
    render(<Anchored handlers={handlers} />);
    await pick(/Cold open/);
    await screen.findByText(/Preview, from the saved episode/);
    await userEvent.click(insertButton());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Inserting into the episode.",
    );
    await userEvent.keyboard("{Escape}");
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => fail(new Error("offline")));
    expect(
      await screen.findByText("That did not insert. Try again."),
    ).toBeVisible();
    expect(screen.getByRole("radio", { name: /Cold open/ })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["segment_unknown", /no longer in your library/],
    ["segment_version_invalid", /version of the segment/],
    ["segment_unreadable", /cannot be read/],
    ["segment_busy", /busy/],
    ["segment_hash_mismatch", /has changed since it was saved/],
    ["segment_media_invalid", /cannot be used/],
    ["segment_write_failed", /could not be copied/],
    ["segment_position_out_of_range", /past the end/],
  ])("explains %s inline and stays open", async (code, message) => {
    const handlers = handlersOf({
      onInsert: vi.fn().mockRejectedValue(new ApiError("raw text", code, 400)),
    });
    const { baseElement } = render(<Anchored handlers={handlers} />);
    await pick(/Cold open/);
    await screen.findByText(/Preview, from the saved episode/);
    await userEvent.click(insertButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent("raw text");
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(insertButton()).toBeEnabled();
    await expectNoA11yViolations(baseElement);
  });

  it("keeps Cancel and Insert inside the form on the anchored card", async () => {
    render(<Anchored handlers={handlersOf()} />);
    const form = (await screen.findByRole("dialog")).querySelector("form");
    expect(form).toContainElement(insertButton());
    expect(form).toContainElement(
      screen.getByRole("button", { name: "Cancel" }),
    );
  });

  it("closes on Cancel without inserting", async () => {
    const handlers = handlersOf();
    render(<Anchored handlers={handlers} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel" }),
    );
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onInsert).not.toHaveBeenCalled();
  });

  it("returns focus to the anchor when it closes", async () => {
    render(<Anchored handlers={handlersOf()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Action bar" })).toHaveFocus(),
    );
  });

  it("shows a load failure with Try again", async () => {
    const onRetryLoad = vi.fn();
    render(
      <InsertSegmentCard
        {...data(null)}
        loadError="Couldn't read the library."
        onRetryLoad={onRetryLoad}
        {...handlersOf()}
        form="bottom"
        open
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't read the library.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Insert" }),
    ).toHaveAccessibleDescription("Your saved segments could not be read.");
  });
});

describe("InsertSegmentCard placement", () => {
  const own = () =>
    screen.getByRole("radio", { name: /Play over the episode/ });
  const ripple = () =>
    screen.getByRole("radio", { name: /Move the rest later/ });
  const choose = () => userEvent.click(own());
  const rows = PLACEMENT_LIBRARY;

  it("hides the choice until a segment is picked and on an empty library", async () => {
    const { unmount } = render(
      <Anchored handlers={handlersOf()} rows={rows} />,
    );
    await screen.findByRole("radio", { name: /Cold open/ });
    expect(
      screen.queryByRole("group", { name: "What happens to the episode" }),
    ).toBeNull();
    expect(
      screen.queryByRole("radio", { name: /Play over the episode/ }),
    ).toBeNull();
    unmount();
    render(<Anchored handlers={handlersOf()} rows={[]} />);
    await screen.findByText(INSERT_EMPTY_LIBRARY);
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("defaults a music segment to Play over the episode and sends its placement", async () => {
    const handlers = handlersOf();
    render(<Anchored handlers={handlers} rows={rows} />);
    await pick(/Warm bed/);
    expect(
      screen.getByRole("group", { name: "What happens to the episode" }),
    ).toBeVisible();
    expect(own()).toBeChecked();
    expect(ripple()).not.toBeChecked();
    expect(ripple()).toBeEnabled();
    expect(ripple()).toHaveAccessibleName(/Later clips, chapters and comments/);
    expect(own()).toHaveAccessibleName(
      /The segment is added on new tracks of its own/,
    );
    expect(screen.queryByText(/Music under dialogue/)).toBeNull();
    await waitFor(() =>
      expect(handlers.loadPreview).toHaveBeenLastCalledWith(
        { segment_id: "bed-5c1d", at: 42, placement: "own_lane" },
        expect.any(AbortSignal),
      ),
    );
    await screen.findByText(/Preview, from the saved episode/);
    await userEvent.click(insertButton());
    expect(handlers.onInsert).toHaveBeenCalledWith({
      name: "Warm bed",
      request: {
        segment_id: "bed-5c1d",
        at: 42,
        version: 1,
        placement: "own_lane",
      },
    });
  });

  it.each([
    ["intro", /Cold open/, "intro-9f3a"],
    ["outro", /Closing thanks/, "outro-1"],
    ["sfx", /Chime/, "sfx-1"],
  ])(
    "defaults %s to Move the rest later, with no placement sent",
    async (role, name, id) => {
      const handlers = handlersOf();
      const row = segment({
        id,
        name: String(name).slice(1, -1),
        kind: role === "intro" ? "intro" : role === "outro" ? "outro" : "other",
        role: role as "intro" | "outro" | "sfx",
      });
      render(<Anchored handlers={handlers} rows={[row]} />);
      await pick(name);
      expect(ripple()).toBeChecked();
      expect(own()).toBeEnabled();
      expect(own()).not.toBeChecked();
      await screen.findByText(/Preview, from the saved episode/);
      expect(handlers.loadPreview).toHaveBeenLastCalledWith(
        { segment_id: id, at: expect.anything() },
        expect.any(AbortSignal),
      );
      await userEvent.click(insertButton());
      const call = vi.mocked(handlers.onInsert).mock.calls[0]![0];
      expect(call.request).not.toHaveProperty("placement");
    },
  );

  it("defaults a dialogue segment to Move the rest later with own lane disabled", async () => {
    const handlers = handlersOf();
    render(<Anchored handlers={handlers} rows={rows} />);
    await pick(/Host read/);
    expect(ripple()).toBeChecked();
    expect(own()).toBeDisabled();
    await screen.findByText(/Preview, from the saved episode/);
    await userEvent.click(insertButton());
    expect(handlers.onInsert).toHaveBeenCalledWith({
      name: "Host read",
      request: { segment_id: "read-3e8b", at: 42, version: 1 },
    });
  });

  it("lets a pick win over the default and resets it when another segment is picked", async () => {
    render(<Anchored handlers={handlersOf()} rows={rows} />);
    await pick(/Warm bed/);
    await userEvent.click(ripple());
    expect(ripple()).toBeChecked();
    await pick(/Cold open/);
    expect(ripple()).toBeChecked();
    await pick(/Warm bed/);
    expect(own()).toBeChecked();
  });

  it("previews and inserts with placement own_lane only when chosen", async () => {
    const handlers = handlersOf({
      loadPreview: vi.fn((request) =>
        Promise.resolve(
          insertPreview({
            segment_id: request.segment_id,
            at: 42,
            clips_moved: 0,
            ...(request.placement ? { placement: request.placement } : {}),
          }),
        ),
      ),
    });
    render(<Anchored handlers={handlers} rows={rows} />);
    await pick(/Warm bed/);
    await choose();
    expect(own()).toBeChecked();
    await waitFor(() =>
      expect(handlers.loadPreview).toHaveBeenLastCalledWith(
        { segment_id: "bed-5c1d", at: 42, placement: "own_lane" },
        expect.any(AbortSignal),
      ),
    );
    await screen.findByText("Adds 0:22 at 0:42 on a new track.");
    await userEvent.click(insertButton());
    expect(handlers.onInsert).toHaveBeenCalledWith({
      name: "Warm bed",
      request: {
        segment_id: "bed-5c1d",
        at: 42,
        version: 1,
        placement: "own_lane",
      },
    });
  });

  it("returns to the default when another segment is picked", async () => {
    render(<Anchored handlers={handlersOf()} rows={rows} />);
    await pick(/Warm bed/);
    await choose();
    await pick(/Acme sponsor read/);
    expect(ripple()).toBeChecked();
    expect(own()).not.toBeChecked();
  });

  it("disables own lane for a dialogue segment, says why and resets a checked one", async () => {
    const handlers = handlersOf();
    const { baseElement } = render(
      <Anchored handlers={handlers} rows={rows} />,
    );
    await pick(/Warm bed/);
    await choose();
    await pick(/Host read/);
    expect(own()).toBeDisabled();
    expect(ripple()).toBeChecked();
    const hint =
      "Dialogue segments always move later content. They cannot have their own lane.";
    expect(screen.getByText(hint)).toBeVisible();
    expect(own()).toHaveAccessibleDescription(expect.stringContaining(hint));
    await waitFor(() =>
      expect(handlers.loadPreview).toHaveBeenLastCalledWith(
        { segment_id: "read-3e8b", at: 42 },
        expect.any(AbortSignal),
      ),
    );
    await expectNoA11yViolations(baseElement);
  });

  it("drops a late ripple preview after the placement changes", async () => {
    const pending: {
      resolve: (value: SegmentInsertPreview) => void;
      signal: AbortSignal;
      placement?: string;
    }[] = [];
    const handlers = handlersOf({
      loadPreview: vi.fn(
        (request, signal) =>
          new Promise<SegmentInsertPreview>((resolve) => {
            pending.push({ resolve, signal, placement: request.placement });
          }),
      ),
    });
    render(<Anchored handlers={handlers} rows={rows} />);
    await pick(/Cold open/);
    await act(async () => pending[0]!.resolve(insertPreview({ at: 42 })));
    await screen.findByText("Adds 0:22 at 0:42.");
    expect(insertButton()).toBeEnabled();
    await choose();
    expect(insertButton()).toBeDisabled();
    expect(screen.queryByText("Adds 0:22 at 0:42.")).toBeNull();
    expect(pending[1]!.placement).toBe("own_lane");
    await act(async () =>
      pending[1]!.resolve(insertPreview({ at: 42, clips_moved: 0 })),
    );
    expect(await screen.findByText(/on a new track/)).toBeVisible();
    expect(insertButton()).toBeEnabled();
    await userEvent.click(ripple());
    expect(insertButton()).toBeDisabled();
  });

  it.each([
    [
      "saved to duck",
      true,
      "It plays at full level over the voices. Ducking is a separate step (podcast edit duck).",
    ],
    [
      "music not saved to duck",
      false,
      "It plays at full level until you run ducking (podcast edit duck), which lowers music under speech.",
    ],
  ])(
    "words the own-lane preview truthfully (%s)",
    async (_label, duck, line) => {
      const row = segment({
        id: "bed-5c1d",
        name: "Warm bed",
        kind: "other",
        role: "music",
        duck_under_dialogue: duck,
      });
      render(<Anchored handlers={handlersOf()} rows={[row]} />);
      await pick(/Warm bed/);
      expect(await screen.findByText(line)).toBeVisible();
      expect(
        screen.getByText("Adds 0:22 at 0:42 on a new track."),
      ).toBeVisible();
      expect(
        screen.getByText("Nothing already in the episode moves."),
      ).toBeVisible();
      expect(screen.getByText("The episode becomes 10:22 long.")).toBeVisible();
      expect(
        screen.queryByText(/ducked automatically|will be ducked/),
      ).toBeNull();
    },
  );

  it("keeps the not-saved-to-duck line for an own-lane sfx", async () => {
    const row = segment({
      id: "chime-1",
      name: "Chime",
      kind: "other",
      role: "sfx",
      duck_under_dialogue: false,
    });
    render(<Anchored handlers={handlersOf()} rows={[row]} />);
    await pick(/Chime/);
    await choose();
    expect(
      await screen.findByText(
        "It plays at full level. It was not saved to duck under dialogue.",
      ),
    ).toBeVisible();
  });

  it.each([
    [
      "segment_placement_unsupported",
      "Dialogue segments cannot have their own lane. Choose Move the rest later.",
    ],
    [
      "segment_placement_invalid",
      "That placement is not available. Pick a placement again.",
    ],
  ])("explains %s on the preview and on insert", async (code, message) => {
    const loadPreview = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("raw", code, 400))
      .mockResolvedValue(insertPreview({ at: 42 }));
    const onInsert = vi.fn().mockRejectedValue(new ApiError("raw", code, 400));
    render(
      <Anchored handlers={handlersOf({ loadPreview, onInsert })} rows={rows} />,
    );
    await pick(/Cold open/);
    expect(await screen.findByText(message)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/Preview, from the saved episode/);
    await choose();
    await screen.findByText(/on a new track/);
    await userEvent.click(insertButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    if (code === "segment_placement_unsupported") {
      expect(ripple()).toBeChecked();
    }
  });

  it("falls back to Move the rest later for a music segment the server refuses on its own lane", async () => {
    const onInsert = vi
      .fn()
      .mockRejectedValue(
        new ApiError("raw", "segment_placement_unsupported", 400),
      );
    render(<Anchored handlers={handlersOf({ onInsert })} rows={rows} />);
    await pick(/Warm bed/);
    await screen.findByText(/on a new track/);
    await userEvent.click(insertButton());
    await screen.findByRole("alert");
    expect(ripple()).toBeChecked();
  });
});

describe("InsertSegmentCard bottom", () => {
  it("is one sheet with the same list and a labelled dialog", async () => {
    const { baseElement } = render(
      <InsertSegmentCard
        {...data([HEALTHY, MULTI_VERSION, DAMAGED])}
        {...handlersOf()}
        form="bottom"
        open
      />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Insert segment",
    });
    expect(dialog).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Cold open/ })).toHaveFocus(),
    );
    await expectNoA11yViolations(baseElement);
  });

  it("pins Cancel and Insert in the sheet footer, outside the form", async () => {
    render(
      <InsertSegmentCard {...data()} {...handlersOf()} form="bottom" open />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Insert segment",
    });
    const footer = dialog.querySelector<HTMLElement>(".sys-sheet-footer");
    const form = dialog.querySelector("form");
    expect(footer).not.toBeNull();
    for (const name of ["Cancel", "Insert"]) {
      const button = screen.getByRole("button", { name });
      expect(footer).toContainElement(button);
      expect(form).not.toContainElement(button);
    }
    expect(insertButton()).toHaveAttribute("form", form?.id);
    expect(insertButton()).toHaveAccessibleDescription("Pick a segment first.");
  });

  it("keeps the actions in the form on a cramped screen", async () => {
    crampedScreen();
    render(
      <InsertSegmentCard {...data()} {...handlersOf()} form="bottom" open />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Insert segment",
    });
    expect(dialog.querySelector(".sys-sheet-footer")).toBeNull();
    expect(dialog.querySelector("form")).toContainElement(insertButton());
    expect(dialog).toHaveClass("bottom-sheet--full");
  });

  it("inserts from the footer by click", async () => {
    const handlers = handlersOf();
    render(<InsertSegmentCard {...data()} {...handlers} form="bottom" open />);
    await pick(/Cold open/);
    await screen.findByText(/Preview, from the saved episode/);
    await userEvent.click(insertButton());
    await waitFor(() => expect(handlers.onInsert).toHaveBeenCalledTimes(1));
  });

  it("inserts when Enter is pressed on the focused footer Insert", async () => {
    const handlers = handlersOf();
    render(<InsertSegmentCard {...data()} {...handlers} form="bottom" open />);
    await pick(/Cold open/);
    await screen.findByText(/Preview, from the saved episode/);
    insertButton().focus();
    await waitFor(() => expect(insertButton()).toHaveFocus());
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(handlers.onInsert).toHaveBeenCalledTimes(1), {
      timeout: 10000,
    });
  }, 15000);

  it("describes Cancel as off while inserting", async () => {
    const onInsert = vi.fn(() => new Promise<void>(() => {}));
    render(
      <InsertSegmentCard
        {...data()}
        {...handlersOf({ onInsert })}
        form="bottom"
        open
      />,
    );
    await pick(/Cold open/);
    await screen.findByText(/Preview, from the saved episode/);
    await userEvent.click(insertButton());
    expect(
      screen.getByRole("button", { name: "Cancel" }),
    ).toHaveAccessibleDescription("Inserting into the episode.");
  });
});

describe("InsertSegmentCard across the phone and desktop forms", () => {
  function Switching({ handlers }: { handlers: Handlers }) {
    const anchor = useRef<HTMLButtonElement>(null);
    const [bottom, setBottom] = useState(false);
    const common = { ...data(), ...handlers };
    return (
      <>
        <button ref={anchor} type="button" onClick={() => setBottom(!bottom)}>
          Switch form
        </button>
        {bottom ? (
          <InsertSegmentCard {...common} form="bottom" open />
        ) : (
          <InsertSegmentCard {...common} anchorRef={anchor} />
        )}
      </>
    );
  }

  it("keeps the pick and the insert in flight when the form changes", async () => {
    let finish!: () => void;
    const onInsert = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const handlers = handlersOf({ onInsert });
    render(<Switching handlers={handlers} />);
    await pick(/Cold open/);
    await screen.findByText(/Preview, from the saved episode/);
    await userEvent.click(insertButton());
    await userEvent.click(
      screen.getByRole("button", { name: "Switch form", hidden: true }),
    );
    expect(
      await screen.findByRole("radio", { name: /Cold open/ }),
    ).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Inserting into the episode.",
    );
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("dialog", { name: "Insert segment" })
        .querySelector(".sys-sheet-footer"),
    ).toContainElement(insertButton());
    finish();
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalledTimes(1));
  });
});
