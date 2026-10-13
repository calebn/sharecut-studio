import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordHostStore } from "../record/hostStore";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, recordSnapshot } from "../test/fixtures";
import { clampZoomPxPerSec, MIN_ZOOM_PX_PER_SEC } from "../utils/zoom";
import { TransportBar } from "./TransportBar";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../commands/execute", () => ({ execute }));

describe("TransportBar desktop edit controls", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        timeline_duration_sec: 60,
        history: {
          ...minimalProject().history,
          can_undo: true,
          can_redo: true,
        },
      }),
    );
    useDawStore.setState({ zoomPxPerSec: 20 });
    useRecordHostStore.getState().setSnapshot(null);
    execute.mockReset();
    execute.mockResolvedValue({ status: "ok" });
  });

  it("keeps history and zoom visible when desktop chrome collapses", async () => {
    const user = userEvent.setup();
    const { container } = render(<TransportBar />);
    expect(container.querySelector(".transport--collapsed")).toBeTruthy();
    for (const [label, command] of [
      ["Undo", "history.undo"],
      ["Redo", "history.redo"],
      ["Zoom out", "view.zoomOut"],
      ["Zoom in", "view.zoomIn"],
    ]) {
      await user.click(screen.getByRole("button", { name: label }));
      expect(execute).toHaveBeenLastCalledWith(command, {}, { skipWhen: true });
    }
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("places history then zoom before tools on a wide desktop for an editor", () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(1400);
    try {
      useDawStore
        .getState()
        .hydrate(shareProjectKey("editor"), minimalProject(), "edit", ["edit"]);
      const { container } = render(<TransportBar />);
      expect(container.querySelector(".transport--collapsed")).toBeNull();
      const controls = container.querySelector(".transport-edit-controls");
      expect(controls?.nextElementSibling).toHaveAttribute(
        "aria-label",
        "Timeline tool",
      );
      expect(
        [...(controls?.querySelectorAll("button") ?? [])].map((button) =>
          button.getAttribute("aria-label"),
        ),
      ).toEqual(["Undo", "Redo", "Zoom out", "Zoom in"]);
    } finally {
      width.mockRestore();
    }
  });

  it("keeps editing controls and recording reachable as status changes at a fixed width", () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(1920);
    try {
      render(<TransportBar />);
      const expectEditingControls = () => {
        for (const label of ["Undo", "Redo", "Zoom out", "Zoom in"]) {
          expect(screen.getByRole("button", { name: label })).toBeVisible();
        }
        expect(screen.getByRole("button", { name: "Menu" })).toBeVisible();
      };
      expect(screen.getByRole("button", { name: "View" })).toBeVisible();
      for (const status of [
        { audioError: "Failed to load audio (mix)", sessionRegion: null },
        {
          audioError: null,
          sessionRegion: { start_sec: 120, end_sec: 150, track_ids: ["host"] },
        },
      ]) {
        act(() => useDawStore.setState(status));
        expectEditingControls();
        expect(
          screen.queryByRole("button", { name: "View" }),
        ).not.toBeInTheDocument();
        act(() =>
          useDawStore.setState({ audioError: null, sessionRegion: null }),
        );
        expect(screen.getByRole("button", { name: "View" })).toBeVisible();
      }
      act(() =>
        useRecordHostStore
          .getState()
          .setSnapshot(
            recordSnapshot({ state: "recording", recording_ms: 12000 }),
          ),
      );
      expectEditingControls();
      expect(
        screen.getByRole("button", { name: "Recording. Open record panel" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "View" }),
      ).not.toBeInTheDocument();
      act(() => useRecordHostStore.getState().setSnapshot(null));
      expect(screen.getByRole("button", { name: "View" })).toBeVisible();
    } finally {
      width.mockRestore();
    }
  });

  it.each(["Undo", "Redo", "Zoom out", "Zoom in"])(
    "activates %s with Enter and Space",
    async (label) => {
      const user = userEvent.setup();
      render(<TransportBar />);
      screen.getByRole("button", { name: label }).focus();
      await user.keyboard("{Enter} ");
      expect(execute).toHaveBeenCalledTimes(2);
    },
  );

  it("announces unavailable history without dispatching and follows updates", async () => {
    const user = userEvent.setup();
    const project = minimalProject();
    useDawStore.getState().hydrate("/tmp/p.json", project);
    render(<TransportBar />);
    const undo = screen.getByRole("button", { name: "Undo" });
    const redo = screen.getByRole("button", { name: "Redo" });
    expect(undo).toHaveAttribute("aria-disabled", "true");
    expect(redo).toHaveAccessibleDescription("Nothing to redo");
    await user.click(undo);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing to undo");
    expect(undo.querySelector(".compact-history-caption")).toHaveTextContent(
      "Noundo",
    );
    await user.click(redo);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing to redo");
    expect(execute).not.toHaveBeenCalled();
    act(() => {
      useDawStore.setState({
        project: {
          ...project,
          history: { ...project.history, can_undo: true, can_redo: true },
        },
      });
    });
    expect(undo).not.toHaveAttribute("aria-disabled");
    expect(redo).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("prevents zoom commands at both session limits", async () => {
    const user = userEvent.setup();
    useDawStore.setState({ zoomPxPerSec: MIN_ZOOM_PX_PER_SEC });
    render(<TransportBar />);
    const out = screen.getByRole("button", { name: "Zoom out" });
    expect(out).toHaveAccessibleDescription("Fully zoomed out");
    await user.click(out);
    expect(execute).not.toHaveBeenCalled();
    act(() => {
      useDawStore.setState({
        zoomPxPerSec: clampZoomPxPerSec(Number.MAX_SAFE_INTEGER, 60),
      });
    });
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    expect(zoomIn).toHaveAccessibleDescription("Fully zoomed in");
    await user.click(zoomIn);
    expect(execute).not.toHaveBeenCalled();
    expect(out).not.toHaveAttribute("aria-disabled");
  });

  it.each(["view", "comment"] as const)(
    "keeps zoom for a %s guest and hides history",
    (guestMode) => {
      useDawStore
        .getState()
        .hydrate(shareProjectKey("guest"), minimalProject(), guestMode, [
          guestMode,
        ]);
      render(<TransportBar />);
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Redo" })).toBeNull();
      expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy();
    },
  );

  it.each([{ compact: true }, { menuOnly: true }])(
    "leaves compact and menu-only controls unchanged for %j",
    (props) => {
      render(<TransportBar {...props} />);
      expect(screen.queryByRole("group", { name: "Undo and redo" })).toBeNull();
      expect(screen.queryByRole("group", { name: "Zoom" })).toBeNull();
    },
  );

  it("has no accessibility violations with the desktop controls", async () => {
    const { container } = render(<TransportBar />);
    await expectNoA11yViolations(container);
  });
});
