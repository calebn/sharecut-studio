import { act, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { executePointerCommand } from "../commands/pointer";
import { registerDawCommands } from "../commands/register";
import { BUSY_REASON } from "../ui/disabledReason";
import { PENDING_REVIEW_QUEUED_MESSAGE } from "../utils/pendingEditLabels";

const BUSY_RETRY_MS = 25;
const BUSY_RETRIES = 400;

export async function decide(verb: "cut" | "keep") {
  registerDawCommands();
  await waitFor(
    () => expect(screen.queryByText("Checking queued timing…")).toBeNull(),
    { timeout: 10_000 },
  );
  // The sheet answers BUSY_REASON before it does anything, so a retry never repeats a decision;
  // a queued notice is a real block that tests assert on, so it ends the retries.
  for (let attempt = 0; attempt < BUSY_RETRIES; attempt += 1) {
    let result: Awaited<ReturnType<typeof executePointerCommand>> | undefined;
    await act(async () => {
      result = await executePointerCommand(
        verb === "cut" ? "edit.delete" : "edit.keep",
      );
    });
    if (
      result?.status !== "disabled" ||
      result.reason !== BUSY_REASON ||
      screen.queryByText(PENDING_REVIEW_QUEUED_MESSAGE)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
  }
}
