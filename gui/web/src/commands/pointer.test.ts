import { describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ status: "ok" })),
);
vi.mock("./execute", () => ({ execute }));

import { runPointerCommand } from "./pointer";

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
});
