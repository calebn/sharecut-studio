import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  SplitSpeakersDialogView,
  type SplitSpeakersDialogViewProps,
  type SplitSpeakersStage,
} from "./SplitSpeakersDialogView";

type Configure = Extract<SplitSpeakersStage, { kind: "configure" }>;

const NO_SELECTION = "Select a range on the timeline first";

function configure(overrides: Partial<Configure> = {}): Configure {
  return {
    kind: "configure",
    count: "2",
    names: [],
    samples: [],
    sampleReason: NO_SELECTION,
    blocker: null,
    countError: null,
    speakerReadiness: "available",
    ...overrides,
  };
}

function view(
  stage: SplitSpeakersStage,
  extra: Partial<SplitSpeakersDialogViewProps> = {},
) {
  return (
    <SplitSpeakersDialogView
      open
      onClose={vi.fn()}
      trackLabel="Interview"
      stage={stage}
      onDownloadSpeakerModel={vi.fn()}
      onCountChange={vi.fn()}
      onNameChange={vi.fn()}
      onMarkSample={vi.fn()}
      onClearSample={vi.fn()}
      onListenSample={vi.fn()}
      onSplit={vi.fn()}
      onCancelSplit={vi.fn()}
      onUndo={vi.fn()}
      onGoTo={vi.fn()}
      onRestart={vi.fn()}
      {...extra}
    />
  );
}

function renderStage(
  stage: SplitSpeakersStage,
  extra: Partial<SplitSpeakersDialogViewProps> = {},
) {
  return render(view(stage, extra));
}

const QUEUED_ROW = {
  id: "speaker-ecapa",
  label: "Speaker model",
  purpose: "speaker recognition",
  tier: "offered",
  size: "~80 MB",
  sizeBytes: null,
  variant: null,
  state: { kind: "queued" },
} as const;

describe("SplitSpeakersDialogView", () => {
  it("shows why Use selection is disabled once, linked from each button", async () => {
    const { baseElement } = renderStage(configure());
    const note = screen.getByText(NO_SELECTION);
    expect(note).toBeVisible();
    for (const n of [1, 2]) {
      const button = screen.getByRole("button", {
        name: `Use selection as Speaker ${n}'s voice`,
      });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(NO_SELECTION);
    }
    await expectNoA11yViolations(baseElement);
  });

  it("shows no sample note when every shown speaker has a sample", () => {
    renderStage(
      configure({
        samples: [
          { startSec: 1, endSec: 4 },
          { startSec: 5, endSec: 8 },
        ],
      }),
    );
    expect(screen.queryByText(NO_SELECTION)).toBeNull();
  });

  it("shows no sample note when the selection is usable", () => {
    renderStage(configure({ sampleReason: null }));
    const button = screen.getByRole("button", {
      name: "Use selection as Speaker 1's voice",
    });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-describedby");
  });

  it("links the footer blocker note to Split speakers", async () => {
    const { baseElement } = renderStage(
      configure({
        sampleReason: null,
        blocker: "Names must be different.",
      }),
    );
    const split = screen.getByRole("button", { name: "Split speakers" });
    expect(split).toBeDisabled();
    const note = screen.getByText("Names must be different.");
    expect(split).toHaveAttribute("aria-describedby", note.id);
    expect(split).toHaveAccessibleDescription("Names must be different.");
    await expectNoA11yViolations(baseElement);
  });

  it("leaves the count error to its field, with one note per reason", () => {
    renderStage(
      configure({
        count: "99",
        countError: "Enter 2 to 8 speakers.",
        blocker: "Enter 2 to 8 speakers.",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Split speakers" }),
    ).toBeDisabled();
    expect(screen.getAllByText("Enter 2 to 8 speakers.")).toHaveLength(1);
    expect(screen.queryByText(NO_SELECTION)).toBeNull();
  });

  it("shows why Download speaker model is blocked by another download", async () => {
    const { baseElement } = renderStage(
      configure({
        sampleReason: null,
        blocker: "Speaker recognition isn't available on this computer.",
        speakerReadiness: "unavailable",
      }),
      {
        onDownloadSpeakerModel: vi.fn(),
        speakerModel: { row: null, busy: true },
      },
    );
    const download = screen.getByRole("button", {
      name: "Download speaker model",
    });
    expect(download).toBeDisabled();
    const note = screen.getByText("Another download is running");
    expect(note).toBeVisible();
    expect(download.closest("p")).not.toContainElement(note);
    expect(download).toHaveAccessibleDescription("Another download is running");
    await expectNoA11yViolations(baseElement);
  });

  it("shows no download note and keeps Download enabled when nothing blocks it", () => {
    renderStage(
      configure({ speakerReadiness: "unavailable", sampleReason: null }),
      {
        onDownloadSpeakerModel: vi.fn(),
        speakerModel: { row: null, busy: false },
      },
    );
    expect(screen.queryByText("Another download is running")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Download speaker model" }),
    ).toBeEnabled();
  });

  it("shows no download note while the speaker model downloads", () => {
    renderStage(
      configure({ speakerReadiness: "unavailable", sampleReason: null }),
      {
        onDownloadSpeakerModel: vi.fn(),
        speakerModel: { row: QUEUED_ROW, busy: true },
      },
    );
    expect(screen.queryByText("Another download is running")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Downloading…" }),
    ).not.toHaveAttribute("aria-describedby");
  });
});
