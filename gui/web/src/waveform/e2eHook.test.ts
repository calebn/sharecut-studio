import { afterEach, describe, expect, it } from "vitest";
import {
  installWaveformE2eHook,
  WAVEFORM_E2E_BUILD,
  type WaveformE2eHook,
} from "./e2eHook";
import { resetRasterClient } from "./rasterClient";

describe("waveform e2e hook", () => {
  afterEach(() => {
    resetRasterClient();
  });

  it("is built into tests", () => {
    expect(WAVEFORM_E2E_BUILD).toBe(true);
  });

  it("exposes backend, render count and parity", async () => {
    const target: Record<string, unknown> = {};
    installWaveformE2eHook(target);
    const hook = target.__SHARECUT_E2E_WAVEFORM as WaveformE2eHook;
    // jsdom has no Worker: nothing renders.
    expect(hook.backend).toBe("none");
    expect(hook.tilesRendered).toBe(0);
    await expect(hook.rasterParity()).resolves.toBeNull();
  });

  it("installs on window by default", () => {
    installWaveformE2eHook();
    expect(
      (window as unknown as Record<string, unknown>).__SHARECUT_E2E_WAVEFORM,
    ).toBeDefined();
    Reflect.deleteProperty(window, "__SHARECUT_E2E_WAVEFORM");
  });
});
