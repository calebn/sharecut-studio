import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import {
  layoutScreen,
  opensSheet,
  renderSelectionBody,
  SELECTION_SURFACES,
  type SelectionKind,
  type SheetScreen,
  sheetScreen,
} from "../inspector/selectionSurface";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import type { ShellBreakpoint } from "../state/types";
import {
  appliedEditRecord,
  clipRow,
  minimalProject,
  pendingEditView,
  sampleComment,
  sampleTrack,
} from "../test/fixtures";
import type { Selection } from "../types/project";
import { wordSelection } from "../utils/rangeSelect";
import { StudioShell } from "./StudioShell";

const viewport = vi.hoisted(() => ({ shell: "tablet" as ShellBreakpoint }));

vi.mock("../hooks/useViewportClass", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useViewportClass")>()),
  useViewportClass: () => viewport.shell,
}));

const offlineStore = vi.hoisted(() => {
  const state = {
    clearConflicts: vi.fn(),
    clearHostConflicts: vi.fn(),
    loadConflicts: vi.fn(),
    loadCommandQueue: vi.fn(),
    loadHostCommandCount: vi.fn(),
    loadHostConflicts: vi.fn(),
  };
  return {
    ...state,
    loadHostAttention: vi.fn(async (projectPath: string) => {
      const [pending, conflicts] = await Promise.all([
        state.loadHostCommandCount(projectPath),
        state.loadHostConflicts(projectPath),
      ]);
      return { pending, conflicts };
    }),
    loadGuestAttention: vi.fn(async (token: string) => {
      const [, conflicts] = await Promise.all([
        state.loadCommandQueue(token),
        state.loadConflicts(token),
      ]);
      return { pending: 0, conflicts };
    }),
  };
});

vi.mock("../services/offlineQueue/offlineStore", () => offlineStore);

vi.mock("../waveform/statusStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../waveform/statusStore")>()),
  useWaveformStatus: () => null,
  useLaneWaveformStatus: () => "idle",
}));

const project = () =>
  minimalProject({
    tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
    clips: {
      clip_count: 2,
      tracks: {
        host: [
          clipRow({
            id: "h1",
            track_id: "host",
            source_end: 2,
            timeline_end: 2,
          }),
        ],
        guest: [
          clipRow({
            id: "c1",
            track_id: "guest",
            timeline_start: 4,
            timeline_end: 14,
          }),
        ],
      },
    },
    pending_edits: [
      pendingEditView({ id: "p1", track_id: "host", track_ids: ["host"] }),
    ],
    applied_edits: {
      count: 1,
      records: [appliedEditRecord({ id: "a1", track_ids: ["host"] })],
    },
    social_clips: [
      {
        id: "s1",
        track_id: "host",
        start: 1,
        end: 9,
        score: 0.8,
        title_suggestion: "Opening",
        approved: false,
        review_required: true,
      },
    ],
    comments: [sampleComment({ id: "k1" })],
    envelopes: [
      {
        track_id: "host",
        parameter: "volume",
        points: [{ id: "e1", time: 1, value: 1 }],
      },
    ],
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "Mira",
          start: 0,
          end: 2,
          text: "Welcome back",
          timeline_start: 0,
          timeline_end: 2,
          mappable: true,
          words: [
            {
              text: "Welcome",
              start: 0,
              end: 1,
              timeline_start: 0,
              timeline_end: 1,
              word_index: 0,
            },
            {
              text: "back",
              start: 1,
              end: 2,
              timeline_start: 1,
              timeline_end: 2,
              word_index: 1,
            },
          ],
        },
      ],
    },
  });

const SELECTIONS: Record<SelectionKind, NonNullable<Selection>> = {
  range: {
    kind: "range",
    target: {
      kind: "exact_range",
      intervals: [{ start: 4, end: 9 }],
      track_ids: ["guest"],
      clips: [],
      media_seals: {},
    },
  },
  transcriptRange: {
    kind: "transcriptRange",
    trackId: "host",
    startWordIndex: 0,
    endWordIndex: 1,
  },
  clip: { kind: "clip", id: "c1", trackId: "guest" },
  bleedAttenuation: {
    kind: "bleedAttenuation",
    id: "c1",
    trackId: "guest",
    regionKey: null,
  },
  pending: { kind: "pending", id: "p1", trackId: "host" },
  applied: { kind: "applied", id: "a1", trackId: "host" },
  track: { kind: "track", trackId: "host" },
  chapter: { kind: "chapter", id: "Intro", time: 3 },
  social: { kind: "social", id: "s1" },
  comment: { kind: "comment", id: "k1" },
  envelope: { kind: "envelope", trackId: "host" },
  envelopePoint: { kind: "envelopePoint", trackId: "host", pointId: "e1" },
};

type Reach = { role: "button" | "heading"; name: string; related?: true };

/**
 * What a person must be able to reach for each kind of selection, in the
 * sheet on a touch shell and in the inspector on the desktop. `related`
 * actions come from the sheet's commands zone, which the desktop aside omits.
 * Typing the table as a Record over the registry's kinds makes a new kind
 * fail to compile until it names its actions.
 */
const REACH: Record<SelectionKind, Reach[]> = {
  range: [
    { role: "button", name: "Cut" },
    { role: "button", name: "Mute" },
    { role: "button", name: "Clear range" },
  ],
  transcriptRange: [
    { role: "button", name: "Add word before" },
    { role: "button", name: "Ignore" },
    { role: "button", name: "Clear range" },
  ],
  clip: [
    { role: "button", name: "Delete" },
    { role: "button", name: "Copy", related: true },
    { role: "button", name: "Cut", related: true },
  ],
  bleedAttenuation: [{ role: "heading", name: "Automatic reduction" }],
  pending: [
    { role: "button", name: "Approve" },
    { role: "button", name: "Reject" },
  ],
  applied: [{ role: "button", name: "Open History" }],
  track: [
    { role: "button", name: "Edit volume envelope" },
    { role: "button", name: "Move track down", related: true },
  ],
  chapter: [
    { role: "button", name: "Delete" },
    { role: "button", name: "Apply" },
  ],
  social: [
    { role: "button", name: "Apply" },
    { role: "button", name: "Seek to start" },
  ],
  comment: [
    { role: "button", name: "Resolve" },
    { role: "button", name: "Reply" },
  ],
  envelope: [{ role: "button", name: "Add point" }],
  envelopePoint: [
    { role: "button", name: "Edit point" },
    { role: "button", name: "Remove volume envelope" },
  ],
};

const SHELLS: ShellBreakpoint[] = ["phone", "tablet", "desktop"];
const RANGE_KINDS: SelectionKind[] = ["range", "transcriptRange"];
const AGENT_RANGE_ADOPTION: Record<SelectionKind, boolean> = {
  range: false,
  transcriptRange: false,
  clip: true,
  bleedAttenuation: true,
  pending: true,
  applied: true,
  track: true,
  chapter: true,
  social: true,
  comment: true,
  envelope: true,
  envelopePoint: true,
};

function mount(shell: ShellBreakpoint) {
  viewport.shell = shell;
  useDawStore.getState().hydrate("/tmp/p.json", project(), null);
  useDawStore.getState().setMobileMode("listen");
  useDawStore.getState().setLayoutMode("default");
  useDawStore.getState().setActiveTab("transcript");
  useDawStore.getState().setSelection(null);
  useDawStore.getState().setRangeArmed(false);
  useDawStore.getState().setCompactInspectorView("half");
  return render(
    <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
      <StudioShell />
    </DawProvider>,
  );
}

function select(selection: NonNullable<Selection>) {
  const mode = screen.queryByRole("button", { name: /^Select:/ });
  if (mode && selection.kind.startsWith("transcript")) fireEvent.click(mode);
  act(() => useDawStore.getState().setSelection(selection));
}

const sheet = () =>
  screen
    .queryAllByRole("dialog")
    .find((dialog) => dialog.classList.contains("bottom-sheet--inspector")) ??
  null;
const rangeRegions = () =>
  screen.queryAllByRole("region", { name: "Range actions" });

describe("selection surfaces reach every kind on every shell", () => {
  beforeEach(() => {
    offlineStore.loadConflicts.mockResolvedValue([]);
    offlineStore.loadCommandQueue.mockResolvedValue([]);
    offlineStore.loadHostConflicts.mockResolvedValue([]);
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    clearRegisteredCommands();
    registerDawCommands();
  });
  afterEach(() => clearRegisteredCommands());

  for (const kind of Object.keys(SELECTION_SURFACES) as SelectionKind[]) {
    for (const shell of SHELLS) {
      it(`${kind} on the ${shell} shell has a body and its actions in one reachable place`, () => {
        const { container } = mount(shell);
        select(SELECTIONS[kind]);

        const touch = shell !== "desktop";
        const home = touch
          ? sheet()
          : RANGE_KINDS.includes(kind)
            ? container.querySelector<HTMLElement>(".daw-shell-transport")
            : container.querySelector<HTMLElement>("aside.inspector");
        expect(home, "where the selection's surface renders").not.toBeNull();
        if (touch) {
          const body = home!.querySelector(".bottom-sheet-body");
          expect(body?.textContent?.trim()).not.toBe("");
        }
        for (const { role, name, related } of REACH[kind]) {
          if (related && !touch) continue;
          expect(within(home!).getByRole(role, { name })).toBeVisible();
        }
        if (touch) {
          expect(
            rangeRegions().filter((region) => !home!.contains(region)),
            "no range controls behind the sheet's scrim",
          ).toEqual([]);
        }
      });
    }
  }

  for (const shell of SHELLS) {
    it(`Select range over a clip puts In and Out where the ${shell} shell can reach them`, () => {
      const { container } = mount(shell);
      select(SELECTIONS.clip);
      act(() => useDawStore.getState().setRangeArmed(true));
      const regions = rangeRegions();
      expect(regions).toHaveLength(1);
      const home =
        shell === "desktop"
          ? container.querySelector(".daw-shell-transport")
          : sheet();
      expect(home?.contains(regions[0]!)).toBe(true);
      expect(within(regions[0]!).getByLabelText("In")).toBeVisible();
      expect(within(regions[0]!).getByLabelText("Out")).toBeVisible();
      expect(
        within(regions[0]!).getByRole("button", {
          name: "Cancel range selection",
        }),
      ).toBeVisible();
    });

    it(`Select range over nothing puts In and Out ${shell === "desktop" ? "in the bar" : "in the sheet"} on the ${shell} shell`, () => {
      const { container } = mount(shell);
      act(() => useDawStore.getState().setRangeArmed(true));
      const regions = rangeRegions();
      expect(regions).toHaveLength(1);
      const home =
        shell === "desktop"
          ? container.querySelector(".daw-shell-transport")
          : sheet();
      expect(home?.contains(regions[0]!)).toBe(true);
      if (shell !== "desktop") {
        expect(
          within(home as HTMLElement).queryByText(/Click a clip/),
        ).toBeNull();
      }
    });

    it(`an agent range over a clip stays ${shell === "phone" ? "out of the bar" : shell === "tablet" ? "in the sheet" : "in the bar"} on the ${shell} shell, and an armed Select range moves it into ${shell === "desktop" ? "the bar" : "the sheet"}`, () => {
      const { container } = mount(shell);
      act(() =>
        useDawStore.setState({ sessionRegion: { start_sec: 4, end_sec: 9 } }),
      );
      select(SELECTIONS.clip);
      const bar = container.querySelector(".daw-shell-transport");
      if (shell === "phone") {
        expect(rangeRegions()).toEqual([]);
      } else if (shell === "tablet") {
        expect(sheet()?.contains(rangeRegions()[0]!)).toBe(true);
      } else {
        expect(bar?.contains(rangeRegions()[0]!)).toBe(true);
      }
      if (shell !== "desktop") {
        act(() => useDawStore.getState().setRangeArmed(true));
      }
      const home = shell === "desktop" ? bar : sheet();
      const regions = rangeRegions();
      expect(regions).toHaveLength(1);
      expect(home?.contains(regions[0]!)).toBe(true);
      expect(
        within(regions[0]!).getByRole("button", {
          name: "Use agent range on selected tracks",
        }),
      ).toBeVisible();
    });
  }

  for (const kind of Object.keys(AGENT_RANGE_ADOPTION) as SelectionKind[]) {
    it(`keeps the agent range in the tablet sheet for ${kind} selections`, () => {
      const { container } = mount("tablet");
      act(() =>
        useDawStore.setState({ sessionRegion: { start_sec: 0, end_sec: 2 } }),
      );
      select(SELECTIONS[kind]);

      const home = sheet();
      const regions = rangeRegions();
      expect(home).not.toBeNull();
      expect(regions).toHaveLength(1);
      expect(home!.contains(regions[0]!)).toBe(true);
      expect(
        container
          .querySelector(".daw-shell-transport")
          ?.querySelector('[aria-label="Range actions"]'),
      ).toBeNull();
      expect(
        within(regions[0]!).queryByRole("button", {
          name: "Use agent range on selected tracks",
        }) !== null,
      ).toBe(AGENT_RANGE_ADOPTION[kind]);
    });
  }

  it("keeps the agent range in the bar while nothing is selected on the tablet", () => {
    const { container } = mount("tablet");
    act(() =>
      useDawStore.setState({ sessionRegion: { start_sec: 4, end_sec: 9 } }),
    );
    expect(sheet()).toBeNull();
    const regions = rangeRegions();
    expect(regions).toHaveLength(1);
    expect(
      container.querySelector(".daw-shell-transport")?.contains(regions[0]!),
    ).toBe(true);
  });
});

describe("a tapped word is one kind", () => {
  const WORD = wordSelection({ trackId: "host", sourceId: null, wordIndex: 0 });

  beforeEach(() => {
    offlineStore.loadConflicts.mockResolvedValue([]);
    offlineStore.loadCommandQueue.mockResolvedValue([]);
    offlineStore.loadHostConflicts.mockResolvedValue([]);
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    clearRegisteredCommands();
    registerDawCommands();
  });
  afterEach(() => clearRegisteredCommands());

  it.each(["phone", "tablet"] as const)(
    "puts the range actions and the word correction in one sheet on the %s shell",
    (shell) => {
      mount(shell);
      select(WORD);
      const home = sheet();
      expect(home).not.toBeNull();
      for (const name of [
        "Cut",
        "Mute",
        "Add word after",
        "Suppress",
        "Copy",
      ]) {
        expect(within(home!).getByRole("button", { name })).toBeVisible();
      }
    },
  );

  it("puts the range actions in the bar and the word correction in the inspector on the desktop", () => {
    const { container } = mount("desktop");
    select(WORD);
    const bar = container.querySelector<HTMLElement>(".daw-shell-transport");
    const rail = container.querySelector<HTMLElement>("aside.inspector");
    expect(within(bar!).getByRole("button", { name: "Cut" })).toBeVisible();
    expect(
      within(rail!).getByRole("button", { name: "Suppress" }),
    ).toBeVisible();
    expect(within(rail!).queryByRole("button", { name: "Cut" })).toBeNull();
  });

  it("keeps the correction out of a longer range", () => {
    mount("tablet");
    select({ ...WORD, endWordIndex: 1 });
    expect(
      within(sheet()!).queryByRole("button", { name: "Suppress" }),
    ).toBeNull();
    expect(within(sheet()!).getByRole("button", { name: "Cut" })).toBeVisible();
  });
});

describe("the sheet opens only on the screens a selection belongs to", () => {
  const SCREENS: SheetScreen[] = [
    "timeline",
    "listen",
    "text",
    "comments",
    "impact",
    "tighten",
  ];
  const ONLY_ON: Partial<Record<SelectionKind, SheetScreen[]>> = {
    range: ["timeline", "listen", "text"],
    transcriptRange: ["timeline", "listen", "text"],
    comment: ["timeline", "listen", "comments"],
    pending: ["timeline", "listen", "impact", "tighten"],
  };

  for (const kind of Object.keys(SELECTION_SURFACES) as SelectionKind[]) {
    it(`${kind} opens it on ${(ONLY_ON[kind] ?? ["timeline", "listen"]).join(", ")}`, () => {
      expect(
        SCREENS.filter((screenName) =>
          opensSheet(SELECTIONS[kind], screenName),
        ),
      ).toEqual(ONLY_ON[kind] ?? ["timeline", "listen"]);
    });
  }

  it("shows no sheet on a More page that does not hold the selection", () => {
    expect(sheetScreen("more", "hub")).toBeNull();
    expect(sheetScreen("more", "history")).toBeNull();
    expect(sheetScreen("more", "comments")).toBe("comments");
    expect(sheetScreen("text", "impact")).toBe("text");
    expect(sheetScreen("more", "tighten")).toBe("tighten");
  });

  it("names the tablet's screen from its layout", () => {
    expect(layoutScreen("default")).toBe("timeline");
    expect(layoutScreen("timeline")).toBe("timeline");
    expect(layoutScreen("text")).toBe("text");
    expect(layoutScreen("review")).toBe("comments");
  });
});

describe("automatic reduction occurrence lookup", () => {
  it.each([
    { id: "c1", trackId: "host" },
    { id: "deleted", trackId: "guest" },
  ])("rejects a missing occurrence $trackId/$id", ({ id, trackId }) => {
    render(
      renderSelectionBody(
        { kind: "bleedAttenuation", id, trackId, regionKey: null },
        {
          project: project(),
          projectEpoch: 1,
          placement: "sheet",
        },
      ),
    );
    expect(screen.getByText("Clip not found")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Automatic reduction" }),
    ).toBeNull();
  });
});
