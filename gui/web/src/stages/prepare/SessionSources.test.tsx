import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { session } from "./prepareFixture";
import type { PrepareSource, SourceActions } from "./prepareTypes";
import { SessionSources } from "./SessionSources";

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

function source(id: string, state: PrepareSource["state"]): PrepareSource {
  return {
    id,
    state,
    name: "",
    fileName: `${id}.wav`,
    audioTime: "5:00 of audio",
    voices: 2,
    progress: 0.2,
    splitDetail: "1 of 9",
    cause: "Could not tell the voices apart.",
  };
}

describe("SessionSources routing", () => {
  it("hands each card's own id to Split, Cancel splitting and Try again", async () => {
    const handlers = actions();
    render(
      <SessionSources
        session={{
          ...session(),
          sources: [
            source("first", "split-prompt"),
            source("second", "split-prompt"),
            source("third", "splitting"),
            source("fourth", "failed"),
          ],
        }}
        firstIndex={1}
        actions={handlers}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Split voice 2" }),
    );
    expect(handlers.onSplit).toHaveBeenCalledWith("second");
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel splitting voice 3" }),
    );
    expect(handlers.onCancelSplit).toHaveBeenCalledWith("third");
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(handlers.onRetry).toHaveBeenCalledWith("fourth");
  });
});
