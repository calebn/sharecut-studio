import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { HistoryPanel } from "./HistoryPanel";

describe("HistoryPanel", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", null);
  });

  it("hides the step count and marks the list busy until groups hydrate", () => {
    const project = minimalProject({
      meta: {
        name: "Test Episode",
        workspace_dir: "/tmp/test",
        hydration: { transcript_words: false, history_groups: false },
      },
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <HistoryPanel />
      </DawProvider>,
    );
    expect(screen.getByText("Loading history…")).toBeTruthy();
    expect(screen.queryByText(/0 steps/)).toBeNull();
    expect(document.querySelector(".history-list")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});
