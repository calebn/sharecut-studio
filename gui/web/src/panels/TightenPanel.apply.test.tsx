import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applySuggestedActions } from "../api";
import { clearRegisteredCommands, execute } from "../commands/execute";
import {
  _resetSingleFlightsForTests,
  registerDawCommands,
} from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { answerQuestions } from "../test/ask";
import { minimalProject, pendingEditView } from "../test/fixtures";
import { TightenPanel } from "./TightenPanel";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadPipelineConfig: vi.fn(async () => new Promise(() => undefined)),
  applySuggestedActions: vi.fn(),
}));

const project = minimalProject({
  pending_edits: [pendingEditView({ id: "hit1", reason: "filler:um" })],
});

beforeEach(() => {
  _resetSingleFlightsForTests();
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate("/tmp/tighten.json", project);
  useDawStore.setState({ activeTab: "tighten" });
  answerQuestions(true);
});

afterEach(() => vi.mocked(applySuggestedActions).mockReset());

it("shows a confirmed command working until its acknowledgment across a panel remount", async () => {
  type Outcome = Awaited<ReturnType<typeof applySuggestedActions>>;
  let finish!: (outcome: Outcome) => void;
  vi.mocked(applySuggestedActions).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let command!: ReturnType<typeof execute>;
  const first = render(<TightenPanel />);
  await act(async () => {
    command = execute("tighten.applySuggested");
  });
  const button = screen.getByRole("button", {
    name: "Apply suggested actions (1)",
  });
  try {
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Applying 1 suggested action…",
    );
    expect(
      within(screen.getByRole("row", { name: /Filler word/ })).getByText(
        "Applying…",
      ),
    ).toBeVisible();
    first.unmount();
    render(<TightenPanel />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Applying 1 suggested action…",
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Search hits" }), {
      target: { value: "no match" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Applying 1 suggested action…",
    );
  } finally {
    await act(async () => {
      finish({ queued: false, summary: "Applied 1 cut", historyHead: null });
      await command;
    });
  }
  expect(
    screen.queryByText("Applying 1 suggested action…"),
  ).not.toBeInTheDocument();
  expect(useDawStore.getState().feedbackToast?.message).toBe("Applied 1 cut");
});
