import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRecordHostStore } from "../record/hostStore";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, recordSnapshot } from "../test/fixtures";
import { TransportBar } from "./TransportBar";

const TRACKS = ["a", "b", "c"].map((id) => ({
  id,
  label: id.toUpperCase(),
  role: "dialogue" as const,
  speaker: null,
  gain_db: 0,
  muted: false,
  duration_sec: 10,
  fx_count: 0,
  stem_is_fresh: true,
}));

describe("TransportBar collapsed", () => {
  beforeEach(() => {
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ timeline_duration_sec: 4000 }));
    useRecordHostStore.getState().setSnapshot(null);
    useRecordHostStore.getState().setCaptureHealth(null);
  });

  it("shows host capture failure in the transport chip during REC", () => {
    useRecordHostStore
      .getState()
      .setSnapshot(recordSnapshot({ state: "recording" }));
    useRecordHostStore.getState().setCaptureHealth("failed");
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TransportBar />
      </DawProvider>,
    );
    expect(
      screen.getByRole("button", {
        name: "Local capture failed. Open record panel",
      }),
    ).toHaveTextContent("REC: local capture failed");
  });

  it("keeps the recording control visible and accessible in a compact transport", async () => {
    useRecordHostStore
      .getState()
      .setSnapshot(
        recordSnapshot({ state: "recording", recording_ms: 12_000 }),
      );
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TransportBar compact />
      </DawProvider>,
    );
    const control = screen.getByRole("button", {
      name: "Recording. Open record panel",
    });
    expect(control).toHaveTextContent("REC");
    expect(control).toHaveTextContent("0:12");
    expect(control).toHaveAccessibleDescription("0:12");
    expect(control.querySelector(".record-rec-dot")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expectNoA11yViolations(container);
  });

  it("keeps a semantic play control and a compact current timecode", () => {
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject({ timeline_duration_sec: 4000 })}
      >
        <TransportBar compact />
      </DawProvider>,
    );
    const play = screen.getByRole("button", { name: "Play" });
    expect(play).toHaveAttribute("data-playing", "false");
    expect(play.querySelector("svg")).toBeTruthy();
    expect(document.querySelector(".timecode-current")).toBeTruthy();
    expect(document.querySelector(".timecode-total")).toBeNull();
  });

  it("keeps Comment and Fit as primary controls when compact", async () => {
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject({ timeline_duration_sec: 4000 })}
      >
        <TransportBar compact showFit />
      </DawProvider>,
    );

    expect(screen.getByRole("button", { name: "Comment" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy();
    const timecode = document.querySelector(".timecode");
    expect(timecode?.textContent).toBeTruthy();
    expect(timecode?.textContent).not.toContain(" / ");
    expect(timecode?.getAttribute("title")).toContain(" / ");

    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("group", { name: "Audition" })).toBeTruthy();
    const shortcuts = within(menu).getByRole("menuitem", {
      name: "Keyboard shortcuts",
    });
    expect(shortcuts.querySelector("kbd")?.textContent).toBe("?");
  });

  it("hides Fit icon when showFit is false and offers Fit in Menu", async () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TransportBar compact showFit={false} />
      </DawProvider>,
    );
    expect(screen.queryByRole("button", { name: "Fit" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(
      within(screen.getByRole("menu")).getByRole("menuitem", {
        name: "Fit to window",
      }),
    ).toBeTruthy();
  });

  it("keeps the open overflow menu accessible", async () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TransportBar compact />
      </DawProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    await expectNoA11yViolations(container);
  });

  it("disables Play and Stop while project is null", () => {
    useDawStore.getState().hydrate("/tmp/p.json", null);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={null}>
        <TransportBar />
      </DawProvider>,
    );
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(
      document.querySelector('[data-presence-anchor="transport:play"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-presence-anchor="transport:stop"]'),
    ).toBeTruthy();
  });

  it("disables host project menu items until a project loads", async () => {
    useDawStore.getState().hydrate("/tmp/p.json", null);
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={null}>
        <TransportBar compact />
      </DawProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    const menu = within(screen.getByRole("menu"));
    const hostProjectItems = ["Bounce…", "Record room…", "Export deliverables"];
    for (const name of hostProjectItems) {
      expect(menu.getByRole("menuitem", { name })).toBeDisabled();
    }
    expect(menu.getByRole("menuitem", { name: "Open project…" })).toBeEnabled();

    // A zero-track project must still re-render the items (null vs empty key).
    act(() => {
      useDawStore.setState({ project: minimalProject({ tracks: [] }) });
    });
    for (const name of hostProjectItems) {
      expect(menu.getByRole("menuitem", { name })).toBeEnabled();
    }
  });

  it("lists people in the overflow menu when collapsed", async () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TransportBar compact showFit />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({
        localClientId: "me",
        sessionClients: [
          {
            client_id: "a",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: { display_name: "Ada", color_index: 2 },
          },
        ],
      });
    });
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(
      within(screen.getByRole("menu")).getByRole("group", { name: "People" }),
    ).toBeTruthy();
  });
});

describe("TransportBar track menu actions", () => {
  async function openTrackMenu(
    selection: { kind: "track"; trackId: string } | null,
  ) {
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject({ tracks: TRACKS })}
      >
        <TransportBar compact />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({ selection });
    });
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    return within(screen.getByRole("menu"));
  }

  it("disables remove and move actions without an inspector track selection", async () => {
    const menu = await openTrackMenu(null);
    expect(menu.getByRole("menuitem", { name: "Remove track" })).toBeDisabled();
    expect(
      menu.getByRole("menuitem", { name: "Move track up" }),
    ).toBeDisabled();
    expect(
      menu.getByRole("menuitem", { name: "Move track down" }),
    ).toBeDisabled();
  });

  it("enables every track action for a movable selected track", async () => {
    const menu = await openTrackMenu({ kind: "track", trackId: "b" });
    expect(menu.getByRole("menuitem", { name: "Remove track" })).toBeEnabled();
    expect(menu.getByRole("menuitem", { name: "Move track up" })).toBeEnabled();
    expect(
      menu.getByRole("menuitem", { name: "Move track down" }),
    ).toBeEnabled();
  });

  it("disables moves that would leave the track order", async () => {
    const menu = await openTrackMenu({ kind: "track", trackId: "a" });
    expect(
      menu.getByRole("menuitem", { name: "Move track up" }),
    ).toBeDisabled();
    expect(
      menu.getByRole("menuitem", { name: "Move track down" }),
    ).toBeEnabled();

    act(() => {
      useDawStore.setState({ selection: { kind: "track", trackId: "c" } });
    });
    expect(menu.getByRole("menuitem", { name: "Move track up" })).toBeEnabled();
    expect(
      menu.getByRole("menuitem", { name: "Move track down" }),
    ).toBeDisabled();
  });
});

describe("TransportBar guest Mix lock", () => {
  function expectMixLocked(scope: HTMLElement, menu: boolean) {
    const audition = menu
      ? within(scope).getByRole("group", { name: "Audition" })
      : within(scope).getByRole("group", { name: "Audition mode" });
    const role = menu ? "menuitemradio" : "button";
    expect(
      within(audition).getByRole(role, { name: "Mix" }),
    ).not.toBeDisabled();
    const fx = within(audition).getByRole(role, { name: "FX" });
    const raw = within(audition).getByRole(role, { name: "Raw" });
    expect(fx).toBeDisabled();
    expect(raw).toBeDisabled();
    expect(fx.getAttribute("aria-description")).toBe("Guests listen in Mix");
    expect(raw.getAttribute("aria-description")).toBe("Guests listen in Mix");
  }

  it("disables FX and Raw in the compact Menu for a viewer", async () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject(), "view");
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject()}
        guestMode="view"
      >
        <TransportBar compact />
      </DawProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expectMixLocked(screen.getByRole("menu"), true);
  });

  it("never offers Help or project actions to a share guest", async () => {
    // Help… (diagnostics bundle) and the Project group are host-only; the
    // inline mayManage check is their only client-side gate.
    const project = minimalProject({ tracks: TRACKS });
    useDawStore.getState().hydrate("share:tok", project, "view", ["play"]);
    render(
      <DawProvider
        projectPath="share:tok"
        initialProject={project}
        guestMode="view"
      >
        <TransportBar />
      </DawProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    const menu = screen.getByRole("menu", { name: "Transport menu" });
    expect(within(menu).queryByRole("menuitem", { name: /^Help/ })).toBeNull();
    expect(within(menu).queryByRole("group", { name: "Project" })).toBeNull();
    expect(
      within(menu).queryByRole("menuitem", { name: /New project/ }),
    ).toBeNull();
  });

  it("disables FX and Raw inline for an editor guest", () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 1200;
      },
    });
    const OrigRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    try {
      useDawStore.getState().hydrate("/tmp/p.json", minimalProject(), "edit");
      render(
        <DawProvider
          projectPath="/tmp/p.json"
          initialProject={minimalProject()}
          guestMode="edit"
        >
          <TransportBar />
        </DawProvider>,
      );
      expectMixLocked(document.body, false);
    } finally {
      globalThis.ResizeObserver = OrigRO;
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  });
});

describe("TransportBar wide layout", () => {
  beforeEach(() => {
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ tracks: TRACKS }));
    // jsdom clientWidth is 0; treat the bar as wide (desktop zones).
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 1400,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  });

  it("groups the bar into start, center, and end zones", () => {
    const { container } = render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject({ tracks: TRACKS })}
      >
        <TransportBar />
      </DawProvider>,
    );
    const zones = [...container.querySelectorAll(".transport-zone")];
    expect(zones.map((zone) => zone.className)).toEqual([
      "transport-zone transport-zone--start",
      "transport-zone transport-zone--center",
      "transport-zone transport-zone--end",
    ]);
    expect(zones[0].querySelector("h1")).toBeTruthy();
    expect(zones[1].querySelector(".play-btn")).toBeTruthy();
    expect(zones[1].querySelector(".timecode")).toBeTruthy();
    expect(zones[2].querySelector(".transport-primary-actions")).toBeTruthy();
  });

  it("splits view controls into their own menu on desktop", async () => {
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject({ tracks: TRACKS })}
      >
        <TransportBar />
      </DawProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "View" }));
    const view = screen.getByRole("menu", { name: "View menu" });
    expect(within(view).getByRole("group", { name: "Layers" })).toBeTruthy();
    expect(within(view).getByRole("menuitem", { name: /Theme:/ })).toBeTruthy();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    const main = screen.getByRole("menu", { name: "Transport menu" });
    expect(within(main).queryByRole("group", { name: "Layers" })).toBeNull();
    expect(within(main).getByRole("group", { name: "Project" })).toBeTruthy();
    expect(within(main).getByRole("group", { name: "Help" })).toBeTruthy();
    await expectNoA11yViolations(main);
  });

  it("shows the audio error on the wide bar and in the collapsed Menu", async () => {
    const project = minimalProject({ tracks: TRACKS });
    const tree = (compact: boolean) => (
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TransportBar compact={compact} />
      </DawProvider>
    );
    const { rerender } = render(tree(false));
    act(() => {
      useDawStore
        .getState()
        .setAudioError("No premix. Run Pipeline or render-preview");
    });
    expect(screen.getByText("No preview")).toBeTruthy();
    rerender(tree(true));
    expect(screen.queryByText("No preview")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(
      screen.getByText(/No preview: No premix\. Run Pipeline/),
    ).toBeTruthy();
  });

  it("keeps the View menu and the main Menu exclusive from the keyboard", async () => {
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject({ tracks: TRACKS })}
      >
        <TransportBar />
      </DawProvider>,
    );
    // An open menu moves focus to its first item on the next frame; let it
    // land first, as it does long before a person can reach another trigger.
    const focusSettlesIn = (name: string) =>
      waitFor(() =>
        expect(
          screen.getByRole("menu", { name }).contains(document.activeElement),
        ).toBe(true),
      );
    await userEvent.click(screen.getByRole("button", { name: "View" }));
    await focusSettlesIn("View menu");

    // Keyboard-only path (no outside pointerdown): Enter on the Menu trigger.
    act(() => screen.getByRole("button", { name: "Menu" }).focus());
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("menu", { name: "View menu" })).toBeNull();
    await focusSettlesIn("Transport menu");

    // The menu closed by the switch must not pull focus back to its own
    // trigger, so Escape returns to the trigger that opened this one.
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Menu" }),
    );

    act(() => screen.getByRole("button", { name: "View" }).focus());
    await userEvent.keyboard("{Enter}");
    await focusSettlesIn("View menu");
    act(() => screen.getByRole("button", { name: "Menu" }).focus());
    await userEvent.keyboard("{Enter}");
    await focusSettlesIn("Transport menu");
    act(() => screen.getByRole("button", { name: "View" }).focus());
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("menu", { name: "Transport menu" })).toBeNull();
    await focusSettlesIn("View menu");
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "View" }),
    );
  });

  it("does not reopen the View menu after the bar collapses and widens", async () => {
    const tree = (compact: boolean) => (
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject({ tracks: TRACKS })}
      >
        <TransportBar compact={compact} />
      </DawProvider>
    );
    const { rerender } = render(tree(false));
    await userEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("menu", { name: "View menu" })).toBeTruthy();
    rerender(tree(true));
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();
    rerender(tree(false));
    expect(screen.getByRole("button", { name: "View" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("menu", { name: "View menu" })).toBeNull();
  });

  it("disables Play until the project has media", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TransportBar />
      </DawProvider>,
    );
    const play = screen.getByRole("button", { name: "Play" });
    expect(play).toBeDisabled();
    expect(play).toHaveAttribute("title", "Import audio to play");
  });
});
