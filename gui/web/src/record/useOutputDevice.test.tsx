import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OUTPUT_KEY,
  type OutputMonitor,
  useOutputDevice,
} from "./useOutputDevice";

const HEADSET = { kind: "audiooutput", deviceId: "hp", label: "Headset" };
const DESK = { kind: "audiooutput", deviceId: "sp", label: "Desk speakers" };
const MIC = { kind: "audioinput", deviceId: "mic", label: "USB Mic" };
const DEFAULT = { kind: "audiooutput", deviceId: "default", label: "Default" };

let listed: unknown[];
let changeListeners: Array<() => void>;

function monitor(
  setSinkId: OutputMonitor["setSinkId"] = vi.fn().mockResolvedValue(undefined),
  extra: Partial<OutputMonitor> = {},
): OutputMonitor {
  return { outputSupported: true, contextGeneration: 1, setSinkId, ...extra };
}

beforeEach(() => {
  localStorage.clear();
  listed = [MIC, DEFAULT, HEADSET, DESK];
  changeListeners = [];
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: () => Promise.resolve(listed),
      addEventListener: (_: string, fn: () => void) => changeListeners.push(fn),
      removeEventListener: (_: string, fn: () => void) => {
        changeListeners = changeListeners.filter((item) => item !== fn);
      },
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("useOutputDevice", () => {
  it("is absent without AudioContext.setSinkId and never touches the devices", () => {
    const setSinkId = vi.fn();
    const { result } = renderHook(() =>
      useOutputDevice({ outputSupported: false, setSinkId }),
    );
    expect(result.current.supported).toBe(false);
    expect(result.current.devices).toEqual([]);
    expect(setSinkId).not.toHaveBeenCalled();
    expect(localStorage.getItem(OUTPUT_KEY)).toBeNull();
  });

  it("lists only speakers, without the default alias", async () => {
    const { result } = renderHook(() => useOutputDevice(monitor()));
    await waitFor(() => expect(result.current.devices).toHaveLength(2));
    expect(result.current.devices).toEqual([
      { id: "hp", label: "Headset" },
      { id: "sp", label: "Desk speakers" },
    ]);
    expect(result.current.selectedId).toBe("");
  });

  it("names an unlabelled speaker by its place in the list", async () => {
    listed = [{ ...HEADSET, label: "" }];
    const { result } = renderHook(() => useOutputDevice(monitor()));
    await waitFor(() =>
      expect(result.current.devices).toEqual([
        { id: "hp", label: "Speaker 1" },
      ]),
    );
  });

  it("applies a pick to the context at once and remembers it", async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useOutputDevice(monitor(setSinkId)));
    await waitFor(() => expect(result.current.devices).toHaveLength(2));
    expect(setSinkId).not.toHaveBeenCalled();
    act(() => result.current.onChange("sp"));
    await waitFor(() => expect(setSinkId).toHaveBeenCalledWith("sp"));
    expect(result.current.selectedId).toBe("sp");
    expect(result.current.error).toBeUndefined();
    expect(localStorage.getItem(OUTPUT_KEY)).toBe("sp");
  });

  it("applies the remembered speaker, and again to a new context", async () => {
    localStorage.setItem(OUTPUT_KEY, "hp");
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ generation }) =>
        useOutputDevice(monitor(setSinkId, { contextGeneration: generation })),
      { initialProps: { generation: 1 } },
    );
    await waitFor(() => expect(setSinkId).toHaveBeenCalledTimes(1));
    expect(setSinkId).toHaveBeenLastCalledWith("hp");
    expect(result.current.selectedId).toBe("hp");
    rerender({ generation: 2 });
    await waitFor(() => expect(setSinkId).toHaveBeenCalledTimes(2));
    expect(setSinkId).toHaveBeenLastCalledWith("hp");
  });

  it("falls back to the default with a note when the browser refuses", async () => {
    const setSinkId = vi
      .fn<(id: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("NotAllowedError"))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useOutputDevice(monitor(setSinkId)));
    await waitFor(() => expect(result.current.devices).toHaveLength(2));
    act(() => result.current.onChange("sp"));
    await waitFor(() =>
      expect(result.current.error).toBe(
        "Couldn't switch speakers. Using the default.",
      ),
    );
    expect(result.current.selectedId).toBe("");
    await waitFor(() => expect(setSinkId).toHaveBeenLastCalledWith(""));
    expect(localStorage.getItem(OUTPUT_KEY)).toBe("");
    act(() => result.current.onChange("hp"));
    await waitFor(() => expect(result.current.error).toBeUndefined());
    expect(result.current.selectedId).toBe("hp");
  });

  it("falls back to the default when the saved speaker disappears", async () => {
    localStorage.setItem(OUTPUT_KEY, "sp");
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useOutputDevice(monitor(setSinkId)));
    await waitFor(() => expect(result.current.selectedId).toBe("sp"));
    listed = [MIC, DEFAULT, HEADSET];
    await act(async () => {
      for (const fn of changeListeners) fn();
    });
    await waitFor(() => expect(result.current.selectedId).toBe(""));
    expect(result.current.error).toBe(
      "Your saved speaker is gone. Using the default.",
    );
    await waitFor(() => expect(setSinkId).toHaveBeenLastCalledWith(""));
    expect(localStorage.getItem(OUTPUT_KEY)).toBe("");
  });

  it("keeps the saved speaker while the list is empty or unreadable", async () => {
    localStorage.setItem(OUTPUT_KEY, "sp");
    listed = [];
    const { result } = renderHook(() => useOutputDevice(monitor()));
    await act(async () => undefined);
    expect(result.current.selectedId).toBe("sp");
    expect(result.current.error).toBeUndefined();
  });
});
