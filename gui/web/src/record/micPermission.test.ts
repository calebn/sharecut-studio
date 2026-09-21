import { describe, expect, it } from "vitest";
import {
  copyForMicStatus,
  MIC_DENIED_COPY,
  MIC_DESKTOP_DENIED_COPY,
  MIC_DESKTOP_PROMPTING_COPY,
  MIC_ERROR_COPY,
  MIC_GRANT_HINT_COPY,
  MIC_PROMPTING_COPY,
  MIC_UNAVAILABLE_COPY,
  micGrantFailed,
  statusFromGumError,
} from "./micPermission";

describe("statusFromGumError", () => {
  it("maps NotAllowedError to denied", () => {
    expect(statusFromGumError("NotAllowedError")).toBe("denied");
    expect(statusFromGumError("PermissionDeniedError")).toBe("denied");
  });

  it("maps NotFoundError to unavailable", () => {
    expect(statusFromGumError("NotFoundError")).toBe("unavailable");
    expect(statusFromGumError("DevicesNotFoundError")).toBe("unavailable");
  });

  it("leaves other names unmapped", () => {
    expect(statusFromGumError("AbortError")).toBeNull();
    expect(statusFromGumError("NotReadableError")).toBeNull();
    expect(statusFromGumError("OverconstrainedError")).toBeNull();
  });
});

describe("micGrantFailed", () => {
  it("is true for terminal grant failures", () => {
    expect(micGrantFailed("denied")).toBe(true);
    expect(micGrantFailed("unavailable")).toBe(true);
    expect(micGrantFailed("error")).toBe(true);
    expect(micGrantFailed("idle")).toBe(false);
    expect(micGrantFailed("prompting")).toBe(false);
    expect(micGrantFailed("granted")).toBe(false);
  });
});

describe("copyForMicStatus", () => {
  it("returns grant-step copy for each lobby state", () => {
    expect(copyForMicStatus("idle")).toBe(MIC_GRANT_HINT_COPY);
    expect(copyForMicStatus("prompting")).toBe(MIC_PROMPTING_COPY);
    expect(copyForMicStatus("denied")).toBe(MIC_DENIED_COPY);
    expect(copyForMicStatus("unavailable")).toBe(MIC_UNAVAILABLE_COPY);
    expect(copyForMicStatus("error")).toBe(MIC_ERROR_COPY);
    expect(copyForMicStatus("granted")).toBeNull();
  });

  it("uses the browser copy outside the Tauri webview", () => {
    expect(copyForMicStatus("prompting")).toBe(MIC_PROMPTING_COPY);
    expect(copyForMicStatus("denied")).toBe(MIC_DENIED_COPY);
  });

  it("uses operating-system guidance in the Tauri webview", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });

    try {
      expect(copyForMicStatus("prompting")).toBe(MIC_DESKTOP_PROMPTING_COPY);
      expect(copyForMicStatus("denied")).toBe(MIC_DESKTOP_DENIED_COPY);
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__;
    }
  });
});
