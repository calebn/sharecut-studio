import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import {
  type CleanupSettings,
  PrepareView,
  type PrepareViewProps,
} from "./PrepareView";
import { useDemoSessions } from "./prepareDemo";
import {
  FAILURE,
  IMPORTING_TAKES,
  NAMED_TAKES,
  ROWS,
  SECOND_SESSION,
  SOME_TERMS,
  session,
  TAKES_WITH_NEW,
  UNNAMED_TAKES,
} from "./prepareFixture";
import type { SourceActions } from "./prepareTypes";

const sourceActions: SourceActions = {
  onName: fn(),
  onRemove: fn(),
  onHear: fn(),
  onVoices: fn(),
  onSplit: fn(),
  onCancelSplit: fn(),
  onRetry: fn(),
  onDetails: fn(),
  onReplace: fn(),
  onMerge: fn(),
  onMove: fn(),
};

const WAITING = {
  label: "Review suggestions",
  disabledReason: "Still getting ready.",
};
const READY = { label: "Review 14 suggestions" };

const meta: Meta<typeof PrepareView> = {
  title: "Stages/Prepare/Prepare",
  component: PrepareView,
  tags: ["autodocs"],
  args: {
    phase: "transcribing",
    sessions: [session({ status: "running", progress: 0.6 })],
    rows: ROWS.running,
    readySummary: "Getting ready: 1 of 5 done",
    cleanup: { tight: "medium", loudness: "podcast" },
    handoff: WAITING,
    terms: SOME_TERMS,
    onTermsChange: fn(),
    onRetranscribe: fn(),
    sourceActions,
    onTarget: fn(),
    onImport: fn(),
    onRecord: fn(),
    onAdvanced: fn(),
    onRowAction: fn(),
    onHandoff: fn(),
    onCleanup: fn(),
  },
  decorators: [
    (Story) => (
      <main
        aria-label="Stage"
        style={{ minBlockSize: "100dvh", background: "var(--color-bg-canvas)" }}
      >
        <Story />
      </main>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'The Prepare stage inside the shell: Sources, Getting ready, Help the transcriber and Cleanup, then the one Stage hand-off. It is a plain div with h2 sections; the shell owns main and the page heading. The order in the DOM is the order on screen at every width, with no CSS reordering, and Tab follows it. From 60rem wide (a container query) it is three columns: Sources 22.5rem on the left, Getting ready in the middle, then the help column with the hand-off at its foot; Tab goes Add audio and Record, the sessions and their cards, Advanced, the rows, vocabulary, Cleanup, hand-off. Narrower it is one column and the Getting ready card moves to the very top, behind a one-line summary button ("Getting ready: 2 of 3 done") that opens the full card in place; the summary exists only at that width, and the first Tab stop is the summary, then Sources. The hand-off sticks to the bottom at 48 px. Work starts by itself after import, so the hand-off is secondary and says why it waits until everything is done, then becomes the one primary. One polite status line speaks the phase when it changes ("Adding 3 files.", "Transcribing started.", "Done. Review 14 suggestions.", or the failed step and its cause), never a progress tick. A drag over the window shows the drop frame and says the same words. The keyboard way to add audio is the Add audio tile. Presentational: data in, callbacks out; the vocabulary field is the Vocabulary surface, with the speaker chips taken from the named Source cards.\n\n**Motion.** Hover and drag-hover use `--motion-hover`; bars grow with `--motion-state`; the phone summary opens with `--motion-panel`. Under reduced motion the spinner stops and the bar stays.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PrepareView>;

/** Holds the Cleanup choice and the Source cards the way the project will. */
function Live(props: PrepareViewProps) {
  const [cleanup, setCleanup] = useState<CleanupSettings>(props.cleanup);
  const [terms, setTerms] = useState(props.terms ?? []);
  const demo = useDemoSessions(props.sessions, props.sourceActions);
  return (
    <PrepareView
      {...props}
      sessions={demo.sessions}
      sourceActions={demo.actions}
      terms={terms}
      onTermsChange={(next) => {
        setTerms(next);
        props.onTermsChange?.(next);
      }}
      cleanup={cleanup}
      onCleanup={(next) => {
        setCleanup(next);
        props.onCleanup(next);
      }}
    />
  );
}

const live: Story["render"] = (args) => <Live {...args} />;
/** The stage's own status line; the vocabulary field keeps a second one for its limit messages. */
const stageStatus = (root: HTMLElement) =>
  root.querySelector(".sys-prepare > p[role='status']") as HTMLElement;
/** Narrow, the rows fold behind the summary button at the top; open it so the rows can be reached. */
async function openReady(canvasElement: HTMLElement) {
  const summary = canvasElement.querySelector<HTMLButtonElement>(
    ".sys-prepare-summary",
  );
  if (
    summary &&
    getComputedStyle(summary).display !== "none" &&
    summary.getAttribute("aria-expanded") === "false"
  ) {
    await userEvent.click(summary);
  }
}
const phone = { viewport: { value: "mobile360", isRotated: false } };

export const Empty: Story = {
  args: { phase: "empty", sessions: [], rows: [] },
  render: live,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    await userEvent.click(
      canvas.getByRole("button", { name: /^Import audio/ }),
    );
    await expect(args.onImport).toHaveBeenCalled();
    await expect(stageStatus(canvasElement)).toHaveTextContent("");
  },
};

export const DropHover: Story = {
  args: {
    phase: "empty",
    sessions: [],
    rows: [],
    dropActive: true,
    dropCount: 3,
  },
  render: live,
  play: async ({ canvasElement }) => {
    await expect(stageStatus(canvasElement)).toHaveTextContent(
      "Drop to add 3 files.",
    );
  },
};

export const Importing: Story = {
  args: {
    phase: "adding",
    addCount: 3,
    sessions: [session({ status: "idle", sources: IMPORTING_TAKES })],
    rows: ROWS.importing,
    readySummary: "Getting ready: 0 of 5 done",
  },
  render: live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(stageStatus(canvasElement)).toHaveTextContent(
      "Adding 3 files.",
    );
    await expect(canvas.getByText("Uploading")).toBeVisible();
  },
};

export const Transcribing: Story = {
  render: live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(stageStatus(canvasElement)).toHaveTextContent(
      "Transcribing started.",
    );
    await openReady(canvasElement);
    const bar = canvas.getAllByRole("progressbar", { name: "Transcribe" })[0];
    await expect(bar).toHaveAttribute(
      "aria-valuetext",
      "2 of 3 speakers · about 1 min left",
    );
  },
};

export const NeedsSpeakerNames: Story = {
  args: {
    sessions: [
      session({ status: "running", progress: 0.6, sources: UNNAMED_TAKES }),
    ],
  },
  render: live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const names = canvas.getAllByLabelText(/^Speaker name/);
    await userEvent.type(names[0], "Maya");
    await expect(
      canvas.getByRole("button", { name: "Hear Maya" }),
    ).toBeVisible();
    await expect(stageStatus(canvasElement)).toHaveTextContent(
      "Transcribing started.",
    );
  },
};

export const NeedsModel: Story = {
  args: {
    phase: "needs-model",
    sessions: [session({ status: "idle" })],
    rows: ROWS.needsModel,
    readySummary: "Getting ready: Transcribe needs you",
    handoff: {
      label: "Review suggestions",
      disabledReason: "Waiting for the download.",
    },
  },
  render: live,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await openReady(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /^Get \(1.6 GB\)/ }),
    );
    await expect(args.onRowAction).toHaveBeenCalledWith(
      "transcribe",
      "download-model",
    );
  },
};

export const Done: Story = {
  args: {
    phase: "done",
    sessions: [session({ status: "done" })],
    rows: ROWS.done,
    readySummary: "Getting ready: all done",
    handoff: READY,
  },
  render: live,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(stageStatus(canvasElement)).toHaveTextContent(
      "Done. Review 14 suggestions.",
    );
    await expect(
      canvas.getAllByRole("button", { name: /Review 14 suggestions/ }),
    ).toHaveLength(1);
    await userEvent.click(
      canvas.getByRole("button", { name: /Review 14 suggestions/ }),
    );
    await expect(args.onHandoff).toHaveBeenCalled();
  },
};

const NEW_AUDIO: Partial<PrepareViewProps> = {
  phase: "new-audio",
  sessions: [
    session({ status: "new", sources: TAKES_WITH_NEW, people: 4, takes: 4 }),
  ],
  rows: ROWS.plan,
  readySummary: "Getting ready: new audio waiting",
  readyNote: "Priya’s audio is new. The other 3 tracks keep their transcripts.",
  handoff: { label: "Process new audio" },
  onRunAll: fn(),
};

export const NewAudioWaiting: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Audio added to a project that already ran. Prepare shows the plan before anything starts: each Getting ready row says what it does and keeps ("Priya only · 3 kept", "All 4 tracks, Priya joins", "Whole episode"). The stage hand-off is the one primary, "Process new audio", and goes back to "Review N suggestions" when the run is done. The new Source card reads "New · not processed yet" and the session "New audio waiting". Skip on a row leaves it out of this run only; nothing is saved. "Run everything again" sits behind the ⋯ next to Advanced.',
      },
    },
  },
  args: NEW_AUDIO,
  render: live,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(stageStatus(canvasElement)).toHaveTextContent(
      "New audio is waiting. Process new audio when you are ready.",
    );
    await openReady(canvasElement);
    await expect(canvas.getByText("New audio waiting")).toBeVisible();
    await expect(
      canvas.getByText("14:11 of audio · not processed yet"),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Skip, Clean and level" }),
    );
    await expect(args.onRowAction).toHaveBeenCalledWith("clean", "skip");
    await userEvent.click(
      canvas.getByRole("button", { name: /Process new audio/ }),
    );
    await expect(args.onHandoff).toHaveBeenCalled();
    await userEvent.click(
      canvas.getByRole("button", { name: "More ways to run" }),
    );
    await userEvent.click(
      canvas.getByRole("menuitem", { name: "Run everything again" }),
    );
    await expect(args.onRunAll).toHaveBeenCalled();
  },
};

export const NewAudioRowSkipped: Story = {
  args: { ...NEW_AUDIO, rows: ROWS.planSkipped },
  render: live,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await openReady(canvasElement);
    await expect(canvas.getByText(/^Skipped this time/)).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Include, Line up tracks" }),
    );
    await expect(args.onRowAction).toHaveBeenCalledWith("align", "include");
  },
};

export const NewAudioPhone: Story = {
  globals: phone,
  args: NEW_AUDIO,
  render: live,
};

export const AfterRunReused: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'After a run that reused earlier results. The rows say "1 new · 3 reused" and one line under the title sums the run up. The numbers come from the job\'s steps (`reuse: { reused, recomputed }`); a step that does not report it shows its usual line, and the summary counts only the steps that do.',
      },
    },
  },
  args: {
    phase: "done",
    sessions: [
      session({ status: "done", sources: TAKES_WITH_NEW, people: 4, takes: 4 }),
    ],
    rows: ROWS.reused,
    readySummary: "Getting ready: all done",
    readyNote:
      "Done in 1 min 12 s. 9 of 13 results were reused, so this run did less.",
    handoff: { label: "Review 16 suggestions" },
  },
  render: live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(stageStatus(canvasElement)).toHaveTextContent(
      "Done. Review 16 suggestions.",
    );
    await openReady(canvasElement);
    await expect(
      canvas.getByText(
        "Done in 1 min 12 s. 9 of 13 results were reused, so this run did less.",
      ),
    ).toBeVisible();
    await expect(canvas.getAllByText("1 new · 3 reused")).toHaveLength(2);
  },
};

export const StepFailed: Story = {
  args: {
    phase: "failed",
    failure: FAILURE,
    sessions: [session({ status: "failed" })],
    rows: ROWS.failed,
    readySummary: "Getting ready: Transcribe failed",
    handoff: {
      label: "Review suggestions",
      disabledReason: "Transcribe did not finish.",
    },
  },
  render: live,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(stageStatus(canvasElement)).toHaveTextContent(
      "Transcribing failed. Try again. The computer ran out of memory.",
    );
    await openReady(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /^Try again/ }));
    await expect(args.onRowAction).toHaveBeenCalledWith(
      "transcribe",
      "try-again",
    );
  },
};

export const TwoSessions: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Two sessions with the same cast. A name that repeats across sessions is a normal repeated cast, so no card says "Another voice is also called Maya."; that hint shows only for two voices with one name in the same session. Control names stay unique ("Hear Maya, voice 1", "Hear Maya, voice 3") and each session\'s target control names its session ("Where this session goes: At the end, Session 2 · 2 Nov").',
      },
    },
  },
  args: {
    sessions: [
      session({ status: "done", sources: NAMED_TAKES.slice(0, 2), takes: 2 }),
      SECOND_SESSION,
    ],
  },
  render: live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("region", { name: "Voice 1, Maya" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("region", { name: "Voice 3, Maya" }),
    ).toBeVisible();
  },
};

export const Phone: Story = {
  globals: phone,
  render: live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // jsdom has no layout, so the stage reads as wide there; the browser runs the phone checks.
    if (canvasElement.getBoundingClientRect().width === 0) return;
    const heading = canvas.getAllByRole("heading", { level: 2 })[0];
    const summary = within(heading).getByRole("button", {
      name: /Getting ready: 1 of 5 done/,
    });
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await userEvent.tab();
    await expect(summary).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    await expect(
      canvas.getByRole("list", { name: "Getting ready" }),
    ).toBeVisible();
  },
};

export const PhoneDone: Story = {
  globals: phone,
  args: {
    phase: "done",
    sessions: [session({ status: "done" })],
    rows: ROWS.done,
    readySummary: "Getting ready: all done",
    handoff: READY,
  },
  render: live,
};
