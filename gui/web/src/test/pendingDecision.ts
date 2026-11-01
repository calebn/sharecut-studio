import { act, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { executePointerCommand } from "../commands/pointer";
import { registerDawCommands } from "../commands/register";

export async function decide(verb: "cut" | "keep") {
  registerDawCommands();
  await waitFor(() =>
    expect(screen.queryByText("Checking queued timing…")).toBeNull(),
  );
  await act(async () => {
    await executePointerCommand(verb === "cut" ? "edit.delete" : "edit.keep");
  });
}
