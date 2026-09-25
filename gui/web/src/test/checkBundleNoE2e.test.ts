import { describe, expect, it } from "vitest";
import { forbiddenE2eMarker } from "../../scripts/check-bundle-no-e2e";

describe("production bundle E2E guard", () => {
  it("rejects page opt-in and signal counters from emitted assets", () => {
    expect(forbiddenE2eMarker("window.__SHARECUT_E2E = true")).toBe(
      "__SHARECUT_E2E",
    );
    expect(forbiddenE2eMarker("window.__SHARECUT_E2E_WAVEFORM = hook")).toBe(
      "__SHARECUT_E2E",
    );
    expect(forbiddenE2eMarker("window.__recordSignalCount++")).toBe(
      "__recordSignalCount",
    );
    expect(forbiddenE2eMarker("ordinary recording code")).toBeUndefined();
  });
});
