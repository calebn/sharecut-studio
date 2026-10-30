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
const COMMS = {
  kind: "audiooutput",
  deviceId: "communications",
  label: "Communications",
};

let listed: unknown[];
let changeListeners: Array<() => void>;

function monitor(
  setSinkId: OutputMonitor["setSinkId"] = vi.fn().mockResolvedValue(true),
  extra: Partial<OutputMonitor> = {},
): OutputMonitor {
  return { outputSupported: true, contextGeneration: 1, setSinkId, ...extra };
}

beforeEach(() => {
  localStorage.clear();
  listed = [MIC, DEFAULT, COMMS, HEADSET, DESK];
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

  it("lists only speakers, without the default and communications aliases", async () => {
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
    const setSinkId = vi.fn().mockResolvedValue(true);
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
    const setSinkId = vi.fn().mockResolvedValue(true);
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

  it("plays on the default with a note when the browser refuses, and keeps the saved pick", async () => {
    const setSinkId = vi
      .fn<(id: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("NotAllowedError"))
      .mockResolvedValue(true);
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
    expect(localStorage.getItem(OUTPUT_KEY)).toBe("sp");
    act(() => result.current.onChange("hp"));
    await waitFor(() => expect(result.current.error).toBeUndefined());
    expect(result.current.selectedId).toBe("hp");
    expect(localStorage.getItem(OUTPUT_KEY)).toBe("hp");
  });

  it("tries a refused pick again when the devices change", async () => {
    const setSinkId = vi
      .fn<(id: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("NotAllowedError"))
      .mockResolvedValue(true);
    const { result } = renderHook(() => useOutputDevice(monitor(setSinkId)));
    await waitFor(() => expect(result.current.devices).toHaveLength(2));
    act(() => result.current.onChange("sp"));
    await waitFor(() => expect(result.current.error).toBeDefined());
    await act(async () => {
      for (const fn of changeListeners) fn();
    });
    await waitFor(() => expect(result.current.selectedId).toBe("sp"));
    expect(result.current.error).toBeUndefined();
  });

  it("plays on the default while the saved speaker is missing, and brings it back when it returns", async () => {
    localStorage.setItem(OUTPUT_KEY, "sp");
    const setSinkId = vi.fn().mockResolvedValue(true);
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
    expect(localStorage.getItem(OUTPUT_KEY)).toBe("sp");
    listed = [MIC, DEFAULT, HEADSET, DESK];
    await act(async () => {
      for (const fn of changeListeners) fn();
    });
    await waitFor(() => expect(result.current.selectedId).toBe("sp"));
    expect(result.current.error).toBeUndefined();
    await waitFor(() => expect(setSinkId).toHaveBeenLastCalledWith("sp"));
  });

  it("keeps the menu and the audio in step when no speaker is listed", async () => {
    localStorage.setItem(OUTPUT_KEY, "sp");
    listed = [];
    const setSinkId = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useOutputDevice(monitor(setSinkId)));
    await waitFor(() =>
      expect(result.current.error).toBe(
        "Your saved speaker is gone. Using the default.",
      ),
    );
    expect(result.current.selectedId).toBe("");
    expect(setSinkId).not.toHaveBeenCalledWith("sp");
    expect(localStorage.getItem(OUTPUT_KEY)).toBe("sp");
  });

  it("offers no speakers and no note when the list cannot be read", async () => {
    localStorage.setItem(OUTPUT_KEY, "sp");
    const enumerateDevices = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices },
    });
    const setSinkId = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useOutputDevice(monitor(setSinkId)));
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalled());
    await act(async () => undefined);
    expect(result.current.devices).toEqual([]);
    expect(result.current.selectedId).toBe("");
    expect(result.current.error).toBeUndefined();
    expect(setSinkId).not.toHaveBeenCalledWith("sp");
    expect(localStorage.getItem(OUTPUT_KEY)).toBe("sp");
  });

  it("reads the labels again on refresh", async () => {
    listed = [{ ...HEADSET, label: "" }];
    const { result } = renderHook(() => useOutputDevice(monitor()));
    await waitFor(() =>
      expect(result.current.devices).toEqual([
        { id: "hp", label: "Speaker 1" },
      ]),
    );
    listed = [HEADSET];
    await act(async () => result.current.refresh());
    await waitFor(() =>
      expect(result.current.devices).toEqual([{ id: "hp", label: "Headset" }]),
    );
  });

  it("keeps the newest list when an older read finishes last", async () => {
    const pending: Array<(list: unknown[]) => void> = [];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: () => new Promise((resolve) => pending.push(resolve)),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const { result } = renderHook(() => useOutputDevice(monitor()));
    act(() => result.current.refresh());
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]([HEADSET]));
    await act(async () => pending[0]([HEADSET, DESK]));
    expect(result.current.devices).toEqual([{ id: "hp", label: "Headset" }]);
  });

  it("does not count a pick as applied before there is a context", async () => {
    localStorage.setItem(OUTPUT_KEY, "hp");
    const setSinkId = vi
      .fn<(id: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { rerender } = renderHook(
      ({ generation }) =>
        useOutputDevice(monitor(setSinkId, { contextGeneration: generation })),
      { initialProps: { generation: 0 } },
    );
    await waitFor(() => expect(setSinkId).toHaveBeenCalledTimes(1));
    rerender({ generation: 1 });
    await waitFor(() => expect(setSinkId).toHaveBeenCalledTimes(2));
    expect(setSinkId).toHaveBeenLastCalledWith("hp");
  });
});
