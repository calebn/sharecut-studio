import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
    useDawStore.setState({
      zoomPxPerSec: 20,
      ingestBusy: false,
      layoutMode: "default",
    });
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
      render(<TransportBar showLayout />);
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
          sessionRegion: { start_sec: 120, end_sec: 150 },
        },
        { ingestBusy: true },
      ]) {
        act(() => useDawStore.setState(status));
        expectEditingControls();
        expect(
          screen.queryByRole("button", { name: "View" }),
        ).not.toBeInTheDocument();
        act(() =>
          useDawStore.setState({
            audioError: null,
            sessionRegion: null,
            ingestBusy: false,
          }),
        );
        expect(screen.getByRole("button", { name: "View" })).toBeVisible();
      }
      for (const layoutMode of ["timeline", "text", "review"] as const) {
        act(() => useDawStore.setState({ layoutMode }));
        expectEditingControls();
        expect(
          screen.queryByRole("button", { name: "View" }),
        ).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /^Restore$/ }));
        expect(execute).toHaveBeenLastCalledWith(
          "layout.default",
          {},
          { skipWhen: true },
        );
        act(() => useDawStore.setState({ layoutMode: "default" }));
        expect(
          screen.queryByRole("button", { name: /^Restore$/ }),
        ).not.toBeInTheDocument();
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

  it.each([1150, 1920])(
    "keeps pointer tools reachable through none/error/recording/region at %spx",
    async (transportWidth) => {
      const width = vi
        .spyOn(HTMLElement.prototype, "clientWidth", "get")
        .mockReturnValue(transportWidth);
      try {
        useDawStore.setState({
          toolMode: "blade",
          commentMode: false,
          timelineFocused: false,
        });
        render(<TransportBar />);
        for (const pressure of ["none", "error", "recording", "region"]) {
          act(() => {
            useDawStore.setState({
              audioError:
                pressure === "error" ? "Failed to load audio (mix)" : null,
              sessionRegion:
                pressure === "region" ? { start_sec: 120, end_sec: 150 } : null,
            });
            useRecordHostStore
              .getState()
              .setSnapshot(
                pressure === "recording"
                  ? recordSnapshot({ state: "recording", recording_ms: 12000 })
                  : null,
              );
          });
          for (const [direct, menuLabel, command] of [
            ["Select tool", "Select tool", "tool.select"],
            ["Blade tool", "Blade tool", "tool.blade"],
            ["Blade cut", "Blade cut", "edit.bladeCut"],
          ]) {
            let control = screen.queryByRole("button", {
              name: direct,
            });
            if (!control) {
              fireEvent.click(screen.getByRole("button", { name: "Menu" }));
              control = screen.getByRole("menuitem", {
                name: menuLabel,
              });
            }
            fireEvent.click(control);
            expect(execute).toHaveBeenLastCalledWith(
              command,
              {},
              { skipWhen: true },
            );
          }
          if (pressure === "error") {
            const menu = screen.getByRole("button", {
              name: "Menu",
            });
            expect(menu).toHaveAttribute(
              "title",
              "Audio failed to load. Open Menu for details.",
            );
            expect(menu).toHaveAccessibleDescription(
              "Failed to load audio (mix)",
            );
            expect(menu.querySelector("svg title")).toHaveTextContent(
              "Audio failed to load",
            );
            fireEvent.click(menu);
            expect(
              screen.getByText(
                "Audio failed to load: Failed to load audio (mix)",
              ),
            ).toBeVisible();
            fireEvent.keyDown(window, { key: "Escape" });
          }
          if (pressure === "recording") {
            expect(
              screen.getByRole("button", {
                name: "Recording. Open record panel",
              }),
            ).toBeVisible();
          }
          if (pressure === "region") {
            fireEvent.click(screen.getByRole("button", { name: "Menu" }));
            expect(screen.getByText("Region 120.0–150.0s")).toBeVisible();
            fireEvent.keyDown(window, { key: "Escape" });
          }
        }
      } finally {
        width.mockRestore();
      }
    },
  );

  it("marks a collapsed desktop audio error and opens its complete details", async () => {
    const user = userEvent.setup();
    useDawStore.setState({ audioError: "Failed to load audio (mix)" });
    render(<TransportBar />);
    const menu = screen.getByRole("button", { name: "Menu" });
    expect(menu).toHaveAttribute(
      "title",
      "Audio failed to load. Open Menu for details.",
    );
    expect(menu).toHaveAccessibleDescription("Failed to load audio (mix)");
    expect(menu.querySelector("svg title")).toHaveTextContent(
      "Audio failed to load",
    );
    await user.click(menu);
    expect(
      screen.getByText("Audio failed to load: Failed to load audio (mix)"),
    ).toBeVisible();
    act(() => useDawStore.setState({ audioError: null }));
    expect(menu).toHaveAttribute("title", "Layers, zoom, theme, and more");
    expect(menu).toHaveAccessibleDescription("Layers, zoom, theme, and more");
    expect(menu).not.toHaveAttribute("aria-describedby");
  });

  it.each(["view", "comment", "suggest", "edit"] as const)(
    "preserves collapsed tool permissions for a %s guest",
    async (guestMode) => {
      const user = userEvent.setup();
      useDawStore
        .getState()
        .hydrate(shareProjectKey("guest"), minimalProject(), guestMode, [
          guestMode,
        ]);
      useDawStore.setState({ toolMode: "blade", commentMode: false });
      render(<TransportBar />);
      await user.click(screen.getByRole("button", { name: "Menu" }));
      expect(
        screen.getByRole("menuitem", { name: "Select tool" }),
      ).not.toHaveAttribute("aria-disabled", "true");
      const blade = screen.getByRole("menuitem", { name: "Blade tool" });
      if (guestMode === "view" || guestMode === "comment") {
        expect(blade).toHaveAttribute("aria-disabled", "true");
        await user.click(blade);
        expect(execute).not.toHaveBeenCalled();
      } else {
        expect(blade).not.toHaveAttribute("aria-disabled", "true");
        await user.click(blade);
        expect(execute).toHaveBeenLastCalledWith(
          "tool.blade",
          {},
          { skipWhen: true },
        );
      }
    },
  );

  it("keeps Blade cut conditional on Blade outside Comment mode", async () => {
    const user = userEvent.setup();
    useDawStore.setState({ toolMode: "select", commentMode: false });
    render(<TransportBar />);
    await user.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.queryByRole("menuitem", { name: "Blade cut" })).toBeNull();
    act(() => useDawStore.setState({ toolMode: "blade", commentMode: false }));
    expect(
      screen.getByRole("menuitem", { name: "Blade cut" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    act(() => useDawStore.setState({ commentMode: true }));
    expect(screen.queryByRole("menuitem", { name: "Blade cut" })).toBeNull();
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
    const { container } = render(<TransportBar />);
    const historyStatus = within(
      container.querySelector<HTMLElement>(".compact-history-controls")!,
    ).getByRole("status");
    const undo = screen.getByRole("button", { name: "Undo" });
    const redo = screen.getByRole("button", { name: "Redo" });
    expect(undo).toHaveAttribute("aria-disabled", "true");
    expect(redo).toHaveAccessibleDescription("Nothing to redo");
    await user.click(undo);
    expect(historyStatus).toHaveTextContent("Nothing to undo");
    expect(undo.querySelector(".compact-history-caption")).toHaveTextContent(
      "Noundo",
    );
    await user.click(redo);
    expect(historyStatus).toHaveTextContent("Nothing to redo");
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
    expect(historyStatus).toBeEmptyDOMElement();
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
    "keeps audio error details available for %j",
    async (props) => {
      const user = userEvent.setup();
      useDawStore.setState({ audioError: "Failed to load audio (mix)" });
      render(<TransportBar {...props} />);
      expect(screen.queryByRole("group", { name: "Undo and redo" })).toBeNull();
      expect(screen.queryByRole("group", { name: "Zoom" })).toBeNull();
      const menu = screen.getByRole("button", { name: "Menu" });
      expect(menu).toHaveAttribute(
        "title",
        props.menuOnly
          ? "Project, audition, and more"
          : "Layers, zoom, theme, and more",
      );
      await user.click(menu);
      expect(
        screen.queryByRole("group", { name: "Timeline tools" }),
      ).toBeNull();
      expect(
        screen.getByText("Audio failed to load: Failed to load audio (mix)"),
      ).toBeVisible();
    },
  );

  it("lists Select a range with Select and Blade in the collapsed Timeline tools", async () => {
    const user = userEvent.setup();
    render(<TransportBar />);
    await user.click(screen.getByRole("button", { name: "Menu" }));
    const tools = screen.getByRole("group", { name: "Timeline tools" });
    expect(
      within(tools)
        .getAllByRole("menuitem")
        .map((el) => el.textContent?.trim()),
    ).toEqual([
      expect.stringMatching(/^Select tool/),
      expect.stringMatching(/^Blade tool/),
      expect.stringMatching(/^Select a range/),
    ]);
    expect(
      screen.queryByRole("group", { name: "Selection" }),
    ).not.toBeInTheDocument();
  });

  it("disables collapsed tools while the project loads", async () => {
    const user = userEvent.setup();
    useDawStore.setState({ project: null });
    render(<TransportBar />);
    await user.click(screen.getByRole("button", { name: "Menu" }));
    expect(
      screen.getByRole("menuitem", { name: "Select tool" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitem", { name: "Blade tool" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("has no accessibility violations with the desktop controls", async () => {
    const { container } = render(<TransportBar />);
    await expectNoA11yViolations(container);
    act(() =>
      useDawStore.setState({ audioError: "Failed to load audio (mix)" }),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Menu" }));
    await expectNoA11yViolations(container);
  });
});
