import { useCallback, useEffect, useRef, useState } from "react";
import { DEVICE_TEXT, type DeviceOutput } from "../system/deviceSheetModel";
import { readLocal, writeLocal } from "../utils/storage";

/** One browser-wide choice, shared by the host's room and a guest's room. */
export const OUTPUT_KEY = "record:output";

/** The slice of the room monitor the speaker choice needs. */
export type OutputMonitor = {
  /** True when the browser's AudioContext can pick a speaker. */
  outputSupported?: boolean;
  /** Counts each AudioContext the monitor opens, so a new one gets the pick again. */
  contextGeneration?: number;
  /** Resolves true once applied, false when there is no context yet to apply it to. */
  setSinkId?: (deviceId: string) => Promise<boolean>;
};

export type OutputDevice = DeviceOutput & {
  onChange: (outputId: string) => void;
  /** Read the speaker list again, for when labels may have just become visible. */
  refresh: () => void;
};

/** What a room without a monitor, or a browser that cannot pick a speaker, reads. */
export const NO_OUTPUT: OutputDevice = {
  supported: false,
  devices: [],
  selectedId: "",
  onChange: () => undefined,
  refresh: () => undefined,
};

/** Browser aliases for whichever speaker is the default; the menu has its own Default. */
const ALIASES = new Set(["default", "communications"]);

function labelled(devices: MediaDeviceInfo[]): { id: string; label: string }[] {
  return devices
    .filter((device) => device.kind === "audiooutput" && device.deviceId)
    .filter((device) => !ALIASES.has(device.deviceId))
    .map((device, index) => ({
      id: device.deviceId,
      label: device.label || `Speaker ${index + 1}`,
    }));
}

/**
 * The room's speaker: the audiooutput list, the pick remembered in this
 * browser, and the pick applied to the monitor's AudioContext as it changes and
 * again whenever the monitor opens a new one. The remembered pick is only ever
 * written by the person's own choice. While its device is missing from the
 * list, or the browser refused it, playback and the menu both use the default
 * with a note, and the pick comes back when the device does.
 */
export function useOutputDevice(monitor: OutputMonitor): OutputDevice {
  const supported = monitor.outputSupported === true;
  const { contextGeneration = 0, setSinkId } = monitor;
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [known, setKnown] = useState(false);
  const [picked, setPicked] = useState(() => readLocal(OUTPUT_KEY) || "");
  const [failedId, setFailedId] = useState<string | null>(null);
  const applied = useRef<{ generation: number; id: string } | null>(null);
  const request = useRef(0);
  const live = useRef(false);

  const refresh = useCallback(() => {
    const mediaDevices = supported ? navigator.mediaDevices : undefined;
    if (!mediaDevices?.enumerateDevices) {
      return;
    }
    const token = ++request.current;
    const current = () => live.current && token === request.current;
    mediaDevices.enumerateDevices().then(
      (list) => {
        if (current()) {
          setDevices(labelled(list));
          setKnown(true);
          // A device that comes back, or any change, earns a refused pick another try.
          setFailedId(null);
        }
      },
      () => {
        if (current()) {
          setDevices([]);
          setKnown(false);
        }
      },
    );
  }, [supported]);

  useEffect(() => {
    live.current = true;
    const mediaDevices = supported ? navigator.mediaDevices : undefined;
    refresh();
    mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      live.current = false;
      mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, [supported, refresh]);

  // The menu can only show a listed speaker, so audio must not use any other.
  const listed = picked !== "" && devices.some((item) => item.id === picked);
  const missing = picked !== "" && known && !listed;
  const refused = listed && failedId === picked;
  const selectedId = listed && !refused ? picked : "";

  useEffect(() => {
    if (!supported || !setSinkId) {
      return;
    }
    const last = applied.current;
    if (last?.generation === contextGeneration && last.id === selectedId) {
      return;
    }
    if (!last && selectedId === "") {
      return;
    }
    applied.current = { generation: contextGeneration, id: selectedId };
    let cancelled = false;
    setSinkId(selectedId).then(
      (done) => {
        // No context yet: the next one (a new generation) gets it.
        if (!done && !cancelled) {
          applied.current = null;
        }
      },
      () => {
        if (!cancelled && selectedId !== "") {
          setFailedId(selectedId);
          applied.current = { generation: -1, id: "" };
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [supported, setSinkId, selectedId, contextGeneration]);

  const onChange = useCallback((outputId: string) => {
    setFailedId(null);
    setPicked(outputId);
    writeLocal(OUTPUT_KEY, outputId);
  }, []);

  if (!supported) {
    return NO_OUTPUT;
  }
  return {
    supported,
    devices,
    selectedId,
    error: refused
      ? DEVICE_TEXT.outputFailed
      : missing
        ? DEVICE_TEXT.outputGone
        : undefined,
    onChange,
    refresh,
  };
}
