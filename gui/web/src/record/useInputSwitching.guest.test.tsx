import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceSheet } from "../system/DeviceSheet";
import { deviceMic } from "./deviceSheet";
import { useInputSwitching } from "./useInputSwitching";
import { useMicPermission } from "./useMicPermission";

type Pending = { resolve: (s: unknown) => void; reject: (e: unknown) => void };
const waiters: Record<string, Pending> = {};
const immediate = new Set<string>();

function fakeStream(id: string) {
  const track = {
    readyState: "live",
    getSettings: () => ({}),
    addEventListener() {},
    removeEventListener() {},
    stop() {},
  };
  return { id, getAudioTracks: () => [track], getTracks: () => [track] };
}

const getUserMedia = vi.fn((constraints: MediaStreamConstraints) => {
  const audio = constraints.audio as MediaTrackConstraints;
  const id = (audio.deviceId as { exact?: string } | undefined)?.exact ?? "";
  return new Promise((resolve, reject) => {
    waiters[id] = { resolve, reject };
    if (immediate.has(id)) resolve(fakeStream(id));
  });
});

function Harness({ deviceId }: { deviceId: string }) {
  const mic = useMicPermission(true, deviceId);
  const switching = useInputSwitching(mic.stream, mic.status, deviceId);
  const { request } = mic;
  useEffect(() => {
    request();
  }, [request]);
  return (
    <DeviceSheet
      mic={deviceMic(
        { status: mic.status, stream: mic.stream, devices: mic.devices },
        { deviceId, levelDb: -60, switching },
      )}
      tone={{ state: "idle", label: "Record room tone" }}
      onInputChange={() => {}}
      onRecordRoomTone={() => {}}
      onClose={() => {}}
    />
  );
}

describe("guest input change with the real mic hook", () => {
  beforeEach(() => {
    getUserMedia.mockClear();
    for (const key of Object.keys(waiters)) delete waiters[key];
    immediate.clear();
    immediate.add("a");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "a", label: "USB Mic" },
          { kind: "audioinput", deviceId: "b", label: "Headset" },
        ],
        addEventListener() {},
        removeEventListener() {},
      },
    });
  });

  it("keeps the same focused select until the new stream opens", async () => {
    const { rerender } = render(<Harness deviceId="a" />);
    const select = await screen.findByLabelText("Input");
    await waitFor(() => expect(select).toHaveValue("a"));
    select.focus();
    rerender(<Harness deviceId="b" />);
    await waitFor(() => expect(waiters.b).toBeDefined());
    expect(screen.getByLabelText("Input")).toBe(select);
    expect(select).toHaveFocus();
    expect(select).toHaveValue("b");
    await act(async () => {
      waiters.b?.resolve(fakeStream("b"));
    });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Input")).toBe(select);
    expect(select).toHaveFocus();
  });

  it("keeps the Input menu with the default choice when the pick fails to open", async () => {
    const { rerender } = render(<Harness deviceId="a" />);
    await screen.findByLabelText("Input");
    rerender(<Harness deviceId="b" />);
    await waitFor(() => expect(waiters.b).toBeDefined());
    await act(async () => {
      waiters.b?.reject(
        Object.assign(new Error("busy"), { name: "NotReadableError" }),
      );
    });
    await screen.findByRole("button", { name: "Retry microphone" });
    const select = screen.getByLabelText("Input");
    expect(select).toHaveValue("b");
    expect(screen.getByRole("option", { name: "Default" })).toBeInTheDocument();
  });
});
