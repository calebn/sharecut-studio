import { describe, expect, it } from "vitest";
import { recordE2eEnabled } from "./e2eHook";

describe("recordE2eEnabled", () => {
  it("requires both e2e=1 and the Playwright init flag", () => {
    const flagged = window as unknown as { __SHARECUT_E2E?: boolean };
    flagged.__SHARECUT_E2E = undefined;
    expect(recordE2eEnabled("?e2e=1")).toBe(false);
    flagged.__SHARECUT_E2E = true;
    expect(recordE2eEnabled("")).toBe(false);
    expect(recordE2eEnabled("?project=/tmp/p")).toBe(false);
    expect(recordE2eEnabled("?e2e=0")).toBe(false);
    expect(recordE2eEnabled("?e2e=1")).toBe(true);
    expect(recordE2eEnabled("?project=/tmp/p&e2e=1")).toBe(true);
    flagged.__SHARECUT_E2E = undefined;
  });
});
