import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { keymapHandoff } from "../../ui/modalGate";
import { formatWaveformAmp } from "../../utils/zoom";
import { SheetHost } from "../frame/SheetHost";
import { EditCorner } from "./EditCorner";
import { EDIT_SHEETS } from "./editSheets";

const viewport = vi.hoisted(() => ({ shell: "desktop" as string }));
vi.mock("../../hooks/useViewportClass", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useViewportClass")>()),
  useViewportClass: () => viewport.shell,
}));

beforeEach(() => {
  viewport.shell = "desktop";
  clearRegisteredCommands();
  registerDawCommands();
  localStorage.clear();
  useDawStore
    .getState()
    .hydrate("/tmp/view/p.json", minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({
    guestMode: null,
    openSheet: null,
    waveformScale: "auto",
    waveformAmpZoom: 1,
    waveformPostFader: false,
    layers: {
      showLevels: false,
      showSilence: true,
      showProsody: false,
    },
  });
});

async function openPopover(user: ReturnType<typeof userEvent.setup>) {
  const eye = screen.getByRole("button", { name: "View options" });
  await user.click(eye);
  const dialog = await screen.findByRole("dialog", { name: "View options" });
  return { eye, dialog };
}

describe("eye popover", () => {
  it("opens a non-modal dialog, marks the eye expanded and is axe-clean", async () => {
    const user = userEvent.setup();
    const { container } = render(<EditCorner />);
    const eye = screen.getByRole("button", { name: "View options" });
    expect(eye).toHaveAttribute("aria-expanded", "false");
    const { dialog } = await openPopover(user);
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(eye).toHaveAttribute("aria-expanded", "true");
    expect(useDawStore.getState().openSheet).toBeNull();
    await expectNoA11yViolations(container);
    await expectNoA11yViolations(dialog);
  });

  it("moves focus to the first chip and returns it to the eye on Escape", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { eye, dialog } = await openPopover(user);
    const first = within(dialog).getAllByRole("button")[0];
    await waitFor(() => expect(first).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
    expect(eye).toHaveFocus();
    expect(eye).toHaveAttribute("aria-expanded", "false");
  });

  it("reverts a typed amplitude on Escape inside the field and keeps the popover open", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { dialog } = await openPopover(user);
    await user.click(
      within(dialog).getByRole("spinbutton", { name: "Waveform amplitude" }),
    );
    const input = within(dialog).getByRole("textbox", {
      name: "Waveform amplitude",
    });
    await user.clear(input);
    await user.type(input, "3");
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: "View options" }),
    ).toBeInTheDocument();
    expect(useDawStore.getState().waveformAmpZoom).toBe(1);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
  });

  it("closes on a press outside and on a second press of the eye", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Elsewhere</button>
        <EditCorner />
      </>,
    );
    await openPopover(user);
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
    await openPopover(user);
    await user.click(screen.getByRole("button", { name: "View options" }));
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
  });

  it("commits an uncommitted typed amplitude when a press outside closes it", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Elsewhere</button>
        <EditCorner />
      </>,
    );
    const { dialog } = await openPopover(user);
    await user.click(
      within(dialog).getByRole("spinbutton", { name: "Waveform amplitude" }),
    );
    const input = within(dialog).getByRole("textbox", {
      name: "Waveform amplitude",
    });
    await user.clear(input);
    await user.type(input, "3");
    expect(useDawStore.getState().waveformAmpZoom).toBe(1);
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
    expect(useDawStore.getState().waveformAmpZoom).toBe(3);
  });

  it("leaves focus where a press outside lands instead of pulling it to the eye", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Elsewhere</button>
        <EditCorner />
      </>,
    );
    const { eye } = await openPopover(user);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
    expect(eye).not.toHaveFocus();
  });

  it("closes in place when another dialog takes focus from it", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Palette</button>
        <EditCorner />
      </>,
    );
    const { eye, dialog } = await openPopover(user);
    const first = within(dialog).getAllByRole("button")[0];
    await waitFor(() => expect(first).toHaveFocus());
    const palette = screen.getByRole("button", { name: "Palette" });
    act(() => palette.focus());
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
    expect(palette).toHaveFocus();
    expect(eye).toHaveAttribute("aria-expanded", "false");
  });

  it("stays open when focus moves between its own controls and to the eye", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { dialog } = await openPopover(user);
    await user.tab();
    expect(
      screen.getByRole("dialog", { name: "View options" }),
    ).toBeInTheDocument();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("keeps a press inside the popover open", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { dialog } = await openPopover(user);
    await user.click(within(dialog).getByRole("button", { name: "Log (dB)" }));
    expect(
      screen.getByRole("dialog", { name: "View options" }),
    ).toBeInTheDocument();
  });

  it("returns focus to the eye when Tab leaves either end", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { eye, dialog } = await openPopover(user);
    const first = within(dialog).getAllByRole("button")[0];
    await waitFor(() => expect(first).toHaveFocus());
    await user.tab({ shift: true });
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
    expect(eye).toHaveFocus();
  });

  it.each(["phone", "desktop"] as const)(
    "closes only the popover on Escape inside the Tools sheet (%s shell)",
    async (shell) => {
      viewport.shell = shell;
      const user = userEvent.setup();
      useDawStore.setState({ openSheet: "tools", shellBreakpoint: shell });
      render(<SheetHost content={EDIT_SHEETS} />);
      await screen.findByRole("group", { name: "Timeline view" });
      // The sheet takes its own entry focus a frame after it opens.
      const sheet = await screen.findByRole("dialog", { name: "Tools" });
      await waitFor(() =>
        expect(sheet).toContainElement(document.activeElement as HTMLElement),
      );
      const { eye } = await openPopover(user);
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
      expect(useDawStore.getState().openSheet).toBe("tools");
      expect(
        screen.getByRole("group", { name: "Timeline view" }),
      ).toBeVisible();
      expect(eye).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(useDawStore.getState().openSheet).toBeNull();
    },
  );

  it("returns focus to the eye when Tab leaves the popover inside the Tools sheet", async () => {
    viewport.shell = "desktop";
    const user = userEvent.setup();
    useDawStore.setState({ openSheet: "tools", shellBreakpoint: "desktop" });
    render(<SheetHost content={EDIT_SHEETS} />);
    const sheet = await screen.findByRole("dialog", { name: "Tools" });
    await waitFor(() =>
      expect(sheet).toContainElement(document.activeElement as HTMLElement),
    );
    const { eye, dialog } = await openPopover(user);
    const first = within(dialog).getAllByRole("button")[0];
    await waitFor(() => expect(first).toHaveFocus());
    await user.tab({ shift: true });
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
    expect(eye).toHaveFocus();
    expect(useDawStore.getState().openSheet).toBe("tools");
  });

  it("keeps the Daw shortcuts running while it is open", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    await openPopover(user);
    expect(keymapHandoff()).toBeNull();
  });

  it("anchors on a phone too, with no sheet in its place", async () => {
    viewport.shell = "phone";
    const user = userEvent.setup();
    render(<EditCorner />);
    const { dialog } = await openPopover(user);
    expect(dialog.closest(".sheet, [data-sheet]")).toBeNull();
    expect(document.body.contains(dialog)).toBe(true);
    expect(useDawStore.getState().openSheet).toBeNull();
  });

  it.each([
    ["Silence shading", "showSilence", true],
    ["Volume envelope", "showLevels", false],
    ["Prosody", "showProsody", false],
  ] as const)("the %s chip toggles layers.%s", async (name, key, initial) => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { dialog } = await openPopover(user);
    const chip = within(dialog).getByRole("button", { name });
    expect(chip).toHaveAttribute("aria-pressed", String(initial));
    await user.click(chip);
    expect(useDawStore.getState().layers[key]).toBe(!initial);
    expect(chip).toHaveAttribute("aria-pressed", String(!initial));
    await user.click(chip);
    expect(useDawStore.getState().layers[key]).toBe(initial);
  });

  it("the Post-fader chip toggles waveformPostFader", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { dialog } = await openPopover(user);
    const chip = within(dialog).getByRole("button", {
      name: "Waveforms post-fader",
    });
    await user.click(chip);
    expect(useDawStore.getState().waveformPostFader).toBe(true);
    expect(chip).toHaveAttribute("aria-pressed", "true");
  });

  it("offers the Prosody chip to a host and never to a share viewer", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<EditCorner />);
    let { dialog } = await openPopover(user);
    expect(
      within(dialog).getByRole("button", { name: "Prosody" }),
    ).toBeInTheDocument();
    unmount();
    useDawStore
      .getState()
      .hydrate(
        shareProjectKey("tok"),
        minimalProject({ tracks: [sampleTrack()] }),
      );
    render(<EditCorner />);
    ({ dialog } = await openPopover(user));
    expect(
      within(dialog).queryByRole("button", { name: "Prosody" }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Silence shading" }),
    ).toBeInTheDocument();
  });

  it("sets the waveform scale from three icon segments and shows which is on", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { dialog } = await openPopover(user);
    const scales = within(dialog).getByRole("group", {
      name: "Waveform scale",
    });
    expect(within(scales).getAllByRole("button")).toHaveLength(3);
    const log = within(scales).getByRole("button", { name: "Log (dB)" });
    await user.click(log);
    expect(useDawStore.getState().waveformScale).toBe("log");
    expect(log).toHaveAttribute("aria-pressed", "true");
    expect(
      within(scales).getByRole("button", { name: "Auto" }),
    ).toHaveAttribute("aria-pressed", "false");
    await user.click(within(scales).getByRole("button", { name: "Linear" }));
    expect(useDawStore.getState().waveformScale).toBe("linear");
  });

  it("scrubs the amplitude by a factor per step, inside 1 to 16", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { dialog } = await openPopover(user);
    const amp = within(dialog).getByRole("spinbutton", {
      name: "Waveform amplitude",
    });
    expect(amp).toHaveAttribute("aria-valuemin", "1");
    expect(amp).toHaveAttribute("aria-valuemax", "16");
    amp.focus();
    await user.keyboard("{ArrowUp}");
    expect(useDawStore.getState().waveformAmpZoom).toBeCloseTo(1.25, 2);
    await user.keyboard("{ArrowUp}");
    expect(useDawStore.getState().waveformAmpZoom).toBeCloseTo(1.56, 2);
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(useDawStore.getState().waveformAmpZoom).toBe(1);
    await user.keyboard("{End}");
    expect(useDawStore.getState().waveformAmpZoom).toBe(16);
    await user.keyboard("{ArrowUp}");
    expect(useDawStore.getState().waveformAmpZoom).toBe(16);
  });

  it("announces an amplitude change with the words of the zoom commands", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { dialog } = await openPopover(user);
    const amp = within(dialog).getByRole("spinbutton", {
      name: "Waveform amplitude",
    });
    amp.focus();
    await user.keyboard("{ArrowUp}");
    const viaField = useDawStore.getState().statusAnnouncement;
    expect(viaField).toBe("Waveform amplitude ×1.25");
    useDawStore.setState({ waveformAmpZoom: 1 });
    await execute("view.waveformZoomIn");
    expect(useDawStore.getState().statusAnnouncement).toBe(viaField);
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(useDawStore.getState().statusAnnouncement).toBe(
      `Waveform amplitude ×${formatWaveformAmp(useDawStore.getState().waveformAmpZoom)}`,
    );
  });

  it("lands on the same amplitudes from the field and from the keyboard command", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { dialog } = await openPopover(user);
    const amp = within(dialog).getByRole("spinbutton", {
      name: "Waveform amplitude",
    });
    amp.focus();
    const viaField: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await user.keyboard("{ArrowUp}");
      viaField.push(useDawStore.getState().waveformAmpZoom);
    }
    useDawStore.setState({ waveformAmpZoom: 1 });
    const viaCommand: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await execute("view.waveformZoomIn");
      viaCommand.push(useDawStore.getState().waveformAmpZoom);
    }
    expect(viaCommand).toEqual(viaField);
    for (let i = 0; i < 4; i += 1) {
      await execute("view.waveformZoomOut");
    }
    expect(useDawStore.getState().waveformAmpZoom).toBe(1);
  });

  it("takes Shift as three steps of 1.25, about double, not ten", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { dialog } = await openPopover(user);
    const amp = within(dialog).getByRole("spinbutton", {
      name: "Waveform amplitude",
    });
    amp.focus();
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(useDawStore.getState().waveformAmpZoom).toBeCloseTo(1.95, 2);
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(useDawStore.getState().waveformAmpZoom).toBe(1);
  });

  it("scrubs the amplitude with a pointer drag, a factor per eight pixels", async () => {
    const user = userEvent.setup();
    render(<EditCorner />);
    const { dialog } = await openPopover(user);
    const amp = within(dialog).getByRole("spinbutton", {
      name: "Waveform amplitude",
    });
    fireEvent.pointerDown(amp, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(amp, { clientX: 110, pointerId: 1 });
    fireEvent.pointerMove(amp, { clientX: 118, pointerId: 1 });
    fireEvent.pointerUp(amp, { clientX: 118, pointerId: 1 });
    expect(useDawStore.getState().waveformAmpZoom).toBeCloseTo(1.25, 2);
    fireEvent.pointerDown(amp, { clientX: 118, pointerId: 2, button: 0 });
    fireEvent.pointerMove(amp, { clientX: 128, pointerId: 2 });
    fireEvent.pointerMove(amp, { clientX: -900, pointerId: 2 });
    fireEvent.pointerUp(amp, { clientX: -900, pointerId: 2 });
    expect(useDawStore.getState().waveformAmpZoom).toBe(1);
  });

  it.each(["edit", "comment", "view"])(
    "never stores a %s guest's share token when the view changes",
    async (guestMode) => {
      const token = "SECRETTOKEN123456";
      localStorage.clear();
      sessionStorage.clear();
      useDawStore
        .getState()
        .hydrate(
          shareProjectKey(token),
          minimalProject({ tracks: [sampleTrack()] }),
        );
      useDawStore.setState({ guestMode });
      const user = userEvent.setup();
      render(<EditCorner />);
      const { dialog } = await openPopover(user);
      await user.click(
        within(dialog).getByRole("button", { name: "Log (dB)" }),
      );
      await user.click(
        within(dialog).getByRole("button", { name: "Waveforms post-fader" }),
      );
      expect(useDawStore.getState().waveformScale).toBe("log");
      expect(useDawStore.getState().waveformPostFader).toBe(true);
      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i) ?? "";
          expect(key).not.toContain(token);
          expect(store.getItem(key)).not.toContain(token);
        }
      }
    },
  );
});
