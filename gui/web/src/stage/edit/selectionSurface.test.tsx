import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import {
  opensSheet,
  SELECTION_SURFACES,
  type SelectionKind,
  type SheetScreen,
} from "../../inspector/selectionSurface";
import { useDawStore } from "../../state/dawStore";
import { DawProvider } from "../../state/store";
import type { ShellBreakpoint } from "../../state/types";
import {
  appliedEditRecord,
  clipRow,
  minimalProject,
  pendingEditView,
  sampleComment,
  sampleTrack,
} from "../../test/fixtures";
import type { Selection } from "../../types/project";
import { wordSelection } from "../../utils/rangeSelect";
import { StageFrame } from "../frame/StageFrame";
import { EditWorkspace } from "./EditWorkspace";
import { EDIT_SHEETS } from "./editSheets";
import { SectionsBody } from "./SectionsBody";

const viewport = vi.hoisted(() => ({ shell: "tablet" as ShellBreakpoint }));

vi.mock("../../hooks/useViewportClass", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useViewportClass")>()),
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

vi.mock("../../services/offlineQueue/offlineStore", () => offlineStore);

vi.mock("../../waveform/statusStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../waveform/statusStore")>()),
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

type Reach = { role: "button" | "heading" | "spinbutton"; name: string };

/**
 * What a person must be able to reach for each kind of selection once Inspect
 * has opened it, in the card on the desktop and the tablet and in the sheet on
 * the phone. The verbs themselves live in the Action bar (EditActionBar.test).
 * Typing the table as a Record over the registry's kinds makes a new kind
 * fail to compile until it names its actions.
 */
const REACH: Record<SelectionKind, Reach[]> = {
  range: [{ role: "button", name: "Select range" }],
  transcriptRange: [
    { role: "button", name: "Add word before" },
    { role: "button", name: "Ignore" },
  ],
  clip: [
    { role: "button", name: "Delete" },
    { role: "button", name: "Copy" },
    { role: "button", name: "Cut" },
  ],
  bleedAttenuation: [{ role: "button", name: "Restore original audio" }],
  pending: [
    { role: "button", name: "Approve" },
    { role: "button", name: "Reject" },
  ],
  applied: [{ role: "button", name: "Open History" }],
  track: [
    { role: "button", name: "Show volume envelope" },
    { role: "button", name: "Move track down" },
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
  envelope: [{ role: "button", name: "Show volume envelope" }],
  envelopePoint: [
    { role: "spinbutton", name: "Time" },
    { role: "spinbutton", name: "Level" },
    { role: "button", name: "Remove volume envelope" },
  ],
};

const SHELLS: ShellBreakpoint[] = ["phone", "tablet", "desktop"];
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
  useDawStore.setState({
    stage: "edit",
    guestMode: null,
    scriptCollapsed: false,
    scriptFocus: false,
    editSurface: "lanes",
    openSheet: null,
  });
  useDawStore.getState().setSelection(null);
  useDawStore.getState().setRangeArmed(false);
  useDawStore.getState().setCompactInspectorView("half");
  return render(
    <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
      <StageFrame sheets={EDIT_SHEETS}>
        <EditWorkspace />
      </StageFrame>
    </DawProvider>,
  );
}

function select(selection: NonNullable<Selection>) {
  const mode = screen.queryByRole("button", { name: /^Select:/ });
  if (mode && selection.kind.startsWith("transcript")) fireEvent.click(mode);
  act(() => useDawStore.getState().setSelection(selection));
}

function inspect() {
  act(() => useDawStore.getState().setInspectorOpen(true));
}

const sheet = () =>
  screen
    .queryAllByRole("dialog")
    .find(
      (dialog) =>
        dialog.classList.contains("sys-inspector") ||
        dialog.classList.contains("bottom-sheet--inspector"),
    ) ?? null;
const rangeRegions = () =>
  screen.queryAllByRole("region", { name: "Range fields" });

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
      it(`${kind} on the ${shell} shell opens a body with its actions in one reachable place on Inspect`, () => {
        mount(shell);
        select(SELECTIONS[kind]);
        expect(sheet(), "selecting alone opens nothing").toBeNull();
        inspect();

        const touch = shell !== "desktop";
        const home = sheet();
        expect(home, "where the selection's surface renders").not.toBeNull();
        expect(home!.textContent?.trim()).not.toBe("");
        for (const { role, name } of REACH[kind]) {
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
          ? container.querySelector(".edit-timeline-col")
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
          ? container.querySelector(".edit-timeline-col")
          : sheet();
      expect(home?.contains(regions[0]!)).toBe(true);
      if (shell !== "desktop") {
        expect(
          within(home as HTMLElement).queryByText(/Click a clip/),
        ).toBeNull();
      }
    });

    it(`an agent range over a clip stays ${shell === "phone" ? "out of the bar" : "in the bar"} on the ${shell} shell, and an armed Select range moves it into ${shell === "desktop" ? "the bar" : "the sheet"}`, () => {
      const { container } = mount(shell);
      act(() =>
        useDawStore.setState({ sessionRegion: { start_sec: 4, end_sec: 9 } }),
      );
      select(SELECTIONS.clip);
      const bar = container.querySelector(".edit-timeline-col");
      if (shell === "phone") {
        expect(rangeRegions()).toEqual([]);
      } else {
        expect(sheet(), "selecting alone opens no sheet").toBeNull();
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
    it(`keeps the agent range in the tablet sheet for ${kind} selections once Inspect opens it`, () => {
      const { container } = mount("tablet");
      act(() =>
        useDawStore.setState({ sessionRegion: { start_sec: 0, end_sec: 2 } }),
      );
      select(SELECTIONS[kind]);
      inspect();

      const home = sheet();
      const regions = rangeRegions();
      expect(home).not.toBeNull();
      expect(regions).toHaveLength(1);
      expect(home!.contains(regions[0]!)).toBe(true);
      expect(
        container
          .querySelector(".edit-timeline-col")
          ?.querySelector('[aria-label="Range fields"]'),
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
      container.querySelector(".edit-timeline-col")?.contains(regions[0]!),
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
    "puts the word correction in the sheet on Inspect and Cut in the bar on the %s shell",
    (shell) => {
      mount(shell);
      select(WORD);
      expect(sheet(), "selecting a word opens no sheet").toBeNull();
      expect(
        screen.getByRole("button", { name: "Cut" }),
        "the Action bar already has Cut",
      ).toBeVisible();
      inspect();
      const home = sheet();
      expect(home).not.toBeNull();
      for (const name of ["Add word after", "Suppress", "Copy"]) {
        expect(within(home!).getByRole("button", { name })).toBeVisible();
      }
      expect(
        within(
          home!.querySelector<HTMLElement>(".sys-inspector-scroll")!,
        ).queryByRole("button", { name: "Cut" }),
      ).toBeNull();
    },
  );

  it("puts Cut in the bar and the word's Suppress in the card on the desktop", () => {
    mount("desktop");
    select(WORD);
    expect(sheet()).toBeNull();
    expect(screen.getByRole("button", { name: "Cut" })).toBeVisible();
    inspect();
    const card = sheet() as HTMLElement;
    expect(
      within(card).getByRole("button", { name: "Suppress" }),
    ).toBeVisible();
    expect(within(card).queryByRole("button", { name: "Cut" })).toBeNull();
  });

  it("keeps the correction out of a longer range", () => {
    mount("tablet");
    select({ ...WORD, endWordIndex: 1 });
    inspect();
    expect(
      within(sheet()!).queryByRole("button", { name: "Suppress" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Cut" })).toBeVisible();
  });
});

describe("Inspect, not selection, opens the surface", () => {
  beforeEach(() => {
    offlineStore.loadConflicts.mockResolvedValue([]);
    offlineStore.loadCommandQueue.mockResolvedValue([]);
    offlineStore.loadHostConflicts.mockResolvedValue([]);
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    clearRegisteredCommands();
    registerDawCommands();
  });
  afterEach(() => clearRegisteredCommands());

  it.each(SHELLS)(
    "shuts on Esc, on a new selection and on Close on the %s shell",
    async (shell) => {
      mount(shell);
      const open = sheet;
      select(SELECTIONS.clip);
      inspect();
      expect(open()).not.toBeNull();
      select(SELECTIONS.pending);
      expect(open()).toBeNull();
      // Esc shuts it before it clears the selection.
      inspect();
      expect(open()).not.toBeNull();
      await act(async () => {
        const { execute } = await import("../../commands/execute");
        await execute("edit.clearSelection", {}, { skipWhen: true });
      });
      expect(open()).toBeNull();
      expect(useDawStore.getState().selection).toMatchObject({
        kind: "pending",
      });
      inspect();
      fireEvent.click(
        within(open() as HTMLElement).getAllByRole("button", {
          name: /^Close/,
        })[0]!,
      );
      expect(open()).toBeNull();
      expect(useDawStore.getState().selection).not.toBeNull();
    },
  );
});

describe("the sheet opens only on the screens a selection belongs to", () => {
  const SCREENS: SheetScreen[] = ["timeline", "text"];
  const ONLY_ON: Partial<Record<SelectionKind, SheetScreen[]>> = {
    range: ["timeline", "text"],
    transcriptRange: ["timeline", "text"],
  };

  for (const kind of Object.keys(SELECTION_SURFACES) as SelectionKind[]) {
    it(`${kind} opens it on ${(ONLY_ON[kind] ?? ["timeline"]).join(", ")}`, () => {
      expect(
        SCREENS.filter((screenName) =>
          opensSheet(SELECTIONS[kind], screenName),
        ),
      ).toEqual(ONLY_ON[kind] ?? ["timeline"]);
    });
  }
});

describe("automatic reduction occurrence lookup", () => {
  it.each([
    { id: "c1", trackId: "host" },
    { id: "deleted", trackId: "guest" },
  ])("rejects a missing occurrence $trackId/$id", ({ id, trackId }) => {
    useDawStore.getState().hydrate("/tmp/p.json", project(), null);
    useDawStore
      .getState()
      .setSelection({ kind: "bleedAttenuation", id, trackId, regionKey: null });
    render(<SectionsBody withRange={false} />);
    expect(screen.getByText("Clip not found")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Restore original audio" }),
    ).toBeNull();
  });
});
