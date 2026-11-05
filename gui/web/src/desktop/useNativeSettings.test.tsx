import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NATIVE_SETTINGS_EVENT, useNativeSettings } from "./useNativeSettings";

function Listener({ open }: { open: () => void }) {
  useNativeSettings(open);
  return null;
}

describe("useNativeSettings", () => {
  it("opens Settings when the native menu dispatches its event", () => {
    const open = vi.fn();
    render(<Listener open={open} />);
    window.dispatchEvent(new CustomEvent(NATIVE_SETTINGS_EVENT));
    expect(open).toHaveBeenCalledOnce();
  });

  it("stops listening once unmounted", () => {
    const open = vi.fn();
    const { unmount } = render(<Listener open={open} />);
    unmount();
    window.dispatchEvent(new CustomEvent(NATIVE_SETTINGS_EVENT));
    expect(open).not.toHaveBeenCalled();
  });

  it("uses the name the native host dispatches", () => {
    expect(NATIVE_SETTINGS_EVENT).toBe("sharecut:open-settings");
  });
});
