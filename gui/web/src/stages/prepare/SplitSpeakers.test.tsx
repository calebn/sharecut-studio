import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { session } from "./prepareFixture";
import type { PrepareSource, SourceActions } from "./prepareTypes";
import { SplitSpeakers, type SplitSpeakersProps } from "./SplitSpeakers";

const recording: PrepareSource = {
  id: "both",
  state: "split-prompt",
  name: "Track 1",
  fileName: "both.wav",
  audioTime: "25:34 of audio",
  voices: 3,
};
const voices: PrepareSource[] = [1, 2, 3].map((n) => ({
  id: `v${n}`,
  state: "needs-name",
  name: "",
  fileName: "both.wav",
  audioTime: `${n}:00 of audio`,
}));

function actions(): SourceActions {
  return {
    onName: vi.fn(),
    onRemove: vi.fn(),
    onHear: vi.fn(),
    onVoices: vi.fn(),
    onSplit: vi.fn(),
    onCancelSplit: vi.fn(),
    onRetry: vi.fn(),
    onDetails: vi.fn(),
    onReplace: vi.fn(),
    onMerge: vi.fn(),
    onMove: vi.fn(),
  };
}

function setup(over: Partial<SplitSpeakersProps> = {}) {
  const handlers = actions();
  const onUndo = vi.fn();
  render(
    <SplitSpeakers
      phase="prompt"
      session={{ ...session(), people: 1, takes: 1 }}
      recording={recording}
      voices={voices}
      actions={handlers}
      toast={null}
      onUndo={onUndo}
      onDismissToast={vi.fn()}
      {...over}
    />,
  );
  return { handlers, onUndo };
}

describe("SplitSpeakers", () => {
  it("asks the question once and splits with the chosen count", async () => {
    const user = userEvent.setup();
    const { handlers } = setup();
    expect(
      screen.getAllByText("One recording of several people?"),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Split Track 1" }));
    expect(handlers.onSplit).toHaveBeenCalledWith("both");
  });

  it("shows plain progress with Cancel splitting", async () => {
    const user = userEvent.setup();
    const { handlers } = setup({
      phase: "splitting",
      recording: {
        ...recording,
        progress: 0.4,
        splitDetail: "About 1 min left",
      },
    });
    expect(screen.getByText("About 1 min left")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Split/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel splitting" }));
    expect(handlers.onCancelSplit).toHaveBeenCalledWith("both");
  });

  it("makes a card per voice, named after hearing, with one Undo", async () => {
    const user = userEvent.setup();
    const { onUndo } = setup({
      phase: "name-voices",
      toast: { id: 1, message: "Split into 3 voices." },
    });
    expect(screen.getAllByRole("button", { name: /^Hear voice/ })).toHaveLength(
      3,
    );
    expect(screen.getByText("2:00 of audio")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("says the plain cause with Try again when it fails", async () => {
    const user = userEvent.setup();
    const { handlers } = setup({ phase: "failed" });
    expect(screen.getByText("Could not tell the voices apart.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(handlers.onRetry).toHaveBeenCalledWith("both");
  });
});
