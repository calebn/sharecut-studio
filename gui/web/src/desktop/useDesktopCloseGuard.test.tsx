import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_GUARD_PARAM,
  useDesktopCloseGuard,
} from "./useDesktopCloseGuard";

const { isTauri } = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri }));

function Guard({
  closeRisk,
  recordingRole,
  canClear = true,
}: {
  closeRisk: boolean;
  recordingRole: "host" | "guest";
  canClear?: boolean;
}) {
  useDesktopCloseGuard(closeRisk, recordingRole, canClear);
  return null;
}

beforeEach(() => {
  isTauri.mockReturnValue(true);
  window.history.replaceState({ project: "test" }, "", "/?project=recording");
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("useDesktopCloseGuard", () => {
  it("publishes the host risk to the native handler without any Tauri IPC", () => {
    render(<Guard closeRisk recordingRole="host" />);
    expect(
      new URL(window.location.href).searchParams.get(CLOSE_GUARD_PARAM),
    ).toBe("host");
    expect(new URL(window.location.href).searchParams.get("project")).toBe(
      "recording",
    );
    expect(window.history.state).toEqual({ project: "test" });
  });

  it("keeps the marker while capture is active and removes it when safe", () => {
    const { rerender } = render(<Guard closeRisk recordingRole="guest" />);
    expect(
      new URL(window.location.href).searchParams.get(CLOSE_GUARD_PARAM),
    ).toBe("guest");
    rerender(<Guard closeRisk={false} recordingRole="guest" />);
    expect(
      new URL(window.location.href).searchParams.has(CLOSE_GUARD_PARAM),
    ).toBe(false);
  });

  it("preserves a prior risk marker until a safe room snapshot arrives", () => {
    window.history.replaceState(null, "", "/?sc_close_guard=host");
    const { rerender } = render(
      <Guard closeRisk={false} recordingRole="host" canClear={false} />,
    );
    expect(
      new URL(window.location.href).searchParams.get(CLOSE_GUARD_PARAM),
    ).toBe("host");
    rerender(<Guard closeRisk recordingRole="host" canClear={false} />);
    rerender(<Guard closeRisk={false} recordingRole="host" canClear />);
    expect(
      new URL(window.location.href).searchParams.has(CLOSE_GUARD_PARAM),
    ).toBe(false);
  });

  it("does not change a browser URL", () => {
    isTauri.mockReturnValue(false);
    render(<Guard closeRisk recordingRole="guest" />);
    expect(
      new URL(window.location.href).searchParams.has(CLOSE_GUARD_PARAM),
    ).toBe(false);
  });
});
