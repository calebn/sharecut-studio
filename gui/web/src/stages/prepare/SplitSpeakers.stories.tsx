import type { Meta, StoryObj } from "@storybook/react-vite";
import { useId, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { VOICE_PEAKS } from "../../system/prepareFixtures";
import { TOAST_UNDO_MS, Toast, type ToastState } from "../../ui";
import { useDemoSessions } from "./prepareDemo";
import { session } from "./prepareFixture";
import type {
  PrepareSession,
  PrepareSource,
  SourceActions,
} from "./prepareTypes";
import { SessionSources } from "./SessionSources";

type SplitPhase = "prompt" | "splitting" | "name-voices" | "failed";

type SplitSpeakersProps = {
  phase: SplitPhase;
  session: Omit<PrepareSession, "sources">;
  /** The one recording of several people. */
  recording: PrepareSource;
  /** The cards the recording became, one per voice, once it is split. */
  voices: readonly PrepareSource[];
  actions: SourceActions;
  /** "Split into 3 voices." with Undo; null once it is gone. */
  toast: ToastState | null;
  onUndo: () => void;
  onDismissToast: () => void;
};

/** The recording's card in the state the phase calls for. */
function recordingFor(phase: SplitPhase, source: PrepareSource): PrepareSource {
  switch (phase) {
    case "prompt":
      return { ...source, state: "split-prompt" };
    case "splitting":
      return { ...source, state: "splitting" };
    case "failed":
      return {
        ...source,
        state: "failed",
        cause: source.cause ?? "Could not tell the voices apart.",
      };
    case "name-voices":
      return source;
  }
}

/**
 * The live split flow, as the stage mounts it: SessionSources renders the
 * Source cards and the Toast offers Undo. Story-only; the stage derives the
 * card states from usePrepareSources.
 */
function SplitSpeakers({
  phase,
  session,
  recording,
  voices,
  actions,
  toast,
  onUndo,
  onDismissToast,
}: SplitSpeakersProps) {
  const headingId = useId();
  const sources =
    phase === "name-voices" ? voices : [recordingFor(phase, recording)];
  return (
    <section className="sys-split" aria-labelledby={headingId}>
      <h2 id={headingId} className="sys-prepare-title">
        Sources
      </h2>
      <SessionSources
        session={{ ...session, sources }}
        firstIndex={1}
        actions={actions}
      />
      <Toast
        toast={phase === "name-voices" ? toast : null}
        onUndo={onUndo}
        onDismiss={onDismissToast}
        timeoutMs={TOAST_UNDO_MS}
      />
    </section>
  );
}

const RECORDING: PrepareSource = {
  id: "both",
  state: "split-prompt",
  name: "Track 1",
  fileName: "interview-both.wav",
  audioTime: "25:34 of audio",
  peaks: VOICE_PEAKS,
  voices: 3,
};

const VOICES: readonly PrepareSource[] = [
  {
    id: "v1",
    state: "needs-name",
    name: "",
    fileName: "interview-both.wav",
    audioTime: "11:02 of audio",
    peaks: VOICE_PEAKS,
  },
  {
    id: "v2",
    state: "needs-name",
    name: "",
    fileName: "interview-both.wav",
    audioTime: "9:41 of audio",
    peaks: VOICE_PEAKS,
  },
  {
    id: "v3",
    state: "needs-name",
    name: "",
    fileName: "interview-both.wav",
    audioTime: "4:51 of audio",
    peaks: VOICE_PEAKS,
  },
];

const spy: SourceActions = {
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

const meta: Meta<typeof SplitSpeakers> = {
  title: "Stages/Prepare/SplitSpeakers",
  component: SplitSpeakers,
  tags: ["autodocs"],
  args: {
    phase: "prompt",
    session: { ...session(), id: "s1", people: 1, takes: 1, duration: "25:34" },
    recording: RECORDING,
    voices: VOICES,
    actions: spy,
    toast: null,
    onUndo: fn(),
    onDismissToast: fn(),
  },
  decorators: [
    (Story) => (
      <main
        aria-label="Stage"
        style={{
          padding: "var(--space-5)",
          maxInlineSize: "30rem",
          background: "var(--color-bg-canvas)",
        }}
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
          'Splitting one recording of several people, in place on its Source card, with no dialog. Prompt asks "One recording of several people?" and offers "How many people?" as a stepper (2 to 8, the reason shown at each limit) and Split. Splitting shows plain progress, "about 1 min left", with Cancel splitting. Name voices turns the card into one card per voice, each with Hear (plays a few seconds of that voice), a name field and its time as "11:02 of audio"; names are typed after hearing, so they cannot rotate. A toast offers one Undo that puts the single recording back. Failed says the plain cause with Try again and Details. Buttons carry the card name ("Split Track 1", "Remove voice 2") so stacked cards differ.\n\n**Motion.** Progress grows with `--motion-state`; the new cards appear with `--motion-panel`. Not implemented in this slice.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SplitSpeakers>;

/** Holds the phase, the voice count and the names the way the project will. */
function Live(props: SplitSpeakersProps) {
  const [phase, setPhase] = useState<SplitPhase>(props.phase);
  const [toast, setToast] = useState<ToastState | null>(props.toast);
  const one = useDemoSessions(
    [{ ...session(), sources: [props.recording] }],
    props.actions,
  );
  const many = useDemoSessions(
    [{ ...session(), sources: props.voices }],
    props.actions,
  );
  const pick = (id: string) => (id === props.recording.id ? one : many);
  const actions: SourceActions = {
    ...props.actions,
    onName: (id, name) => pick(id).actions.onName(id, name),
    onVoices: (id, voices) => pick(id).actions.onVoices(id, voices),
    onHear: (id) => pick(id).actions.onHear(id),
    onSplit: (id) => {
      props.actions.onSplit(id);
      setPhase("splitting");
    },
    onCancelSplit: (id) => {
      props.actions.onCancelSplit(id);
      setPhase("prompt");
    },
    onRetry: (id) => {
      props.actions.onRetry(id);
      setPhase("splitting");
    },
  };
  const recording: PrepareSource = {
    ...one.sessions[0].sources[0],
    progress: 0.4,
    splitDetail: "About 1 min left",
  };
  return (
    <SplitSpeakers
      {...props}
      phase={phase}
      recording={recording}
      voices={many.sessions[0].sources}
      actions={actions}
      toast={toast}
      onUndo={() => {
        props.onUndo();
        setToast(null);
        setPhase("prompt");
      }}
      onDismissToast={() => {
        props.onDismissToast();
        setToast(null);
      }}
    />
  );
}

const live: Story["render"] = (args) => <Live {...args} />;

export const Prompt: Story = {
  render: live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByText("One recording of several people?"),
    ).toHaveLength(1);
    await userEvent.click(canvas.getByRole("button", { name: /^More voices/ }));
    await expect(
      canvas.getByRole("group", { name: "Number of voices" }),
    ).toHaveTextContent("4");
    await expect(
      canvas.getByRole("button", { name: "Split Track 1" }),
    ).toBeVisible();
  },
};

export const Splitting: Story = {
  args: { phase: "splitting" },
  render: live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("progressbar", { name: "Finding voices" }),
    ).toHaveAttribute("aria-valuetext", "About 1 min left");
  },
};

export const NameVoices: Story = {
  args: {
    phase: "name-voices",
    toast: { id: 1, message: "Split into 3 voices." },
  },
  render: live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Hear voice 2" }),
    ).toBeVisible();
    await userEvent.type(
      canvas.getAllByLabelText(/^Speaker name/)[1],
      "Anneke",
    );
    await expect(
      canvas.getByRole("button", { name: "Hear Anneke" }),
    ).toBeVisible();
  },
};

export const Failed: Story = {
  args: { phase: "failed" },
  render: live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Could not tell the voices apart."),
    ).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
  render: live,
};
