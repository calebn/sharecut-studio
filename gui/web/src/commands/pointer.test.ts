import { describe, expect, it, vi } from "vitest";
import type { ExecuteResult } from "./types";

const execute = vi.hoisted(() =>
  vi.fn((): Promise<ExecuteResult> => Promise.resolve({ status: "ok" })),
);
vi.mock("./execute", () => ({ execute }));

import { executePointerCommand, runPointerCommand } from "./pointer";

describe("runPointerCommand", () => {
  it("dispatches with skipWhen and empty args by default", () => {
    runPointerCommand("tool.select");
    expect(execute).toHaveBeenCalledWith("tool.select", {}, { skipWhen: true });
  });

  it("forwards args", () => {
    runPointerCommand("view.setTab", { tab: "mix" });
    expect(execute).toHaveBeenCalledWith(
      "view.setTab",
      { tab: "mix" },
      { skipWhen: true },
    );
  });

  it("returns the command result unchanged", async () => {
    const results = [
      { status: "ok" },
      { status: "disabled", reason: "Unavailable" },
      { status: "unknown" },
    ] as const;
    for (const result of results) {
      execute.mockResolvedValueOnce(result);
      await expect(
        executePointerCommand("view.setTab", { tab: "mix" }),
      ).resolves.toEqual(result);
    }
    expect(execute).toHaveBeenCalledWith(
      "view.setTab",
      { tab: "mix" },
      { skipWhen: true },
    );
  });

  it("leaves command rejection observable", async () => {
    const failure = new Error("Command failed");
    execute.mockRejectedValueOnce(failure);

    await expect(executePointerCommand("tool.select")).rejects.toBe(failure);
  });
});
