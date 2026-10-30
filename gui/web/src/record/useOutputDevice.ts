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
  setSinkId?: (deviceId: string) => Promise<void>;
};

export type OutputDevice = DeviceOutput & {
  onChange: (outputId: string) => void;
};

/** What a room without a monitor, or a browser that cannot pick a speaker, reads. */
export const NO_OUTPUT: OutputDevice = {
  supported: false,
  devices: [],
  selectedId: "",
  onChange: () => undefined,
};

function labelled(devices: MediaDeviceInfo[]): { id: string; label: string }[] {
  return devices
    .filter((device) => device.kind === "audiooutput" && device.deviceId)
    .filter((device) => device.deviceId !== "default")
    .map((device, index) => ({
      id: device.deviceId,
      label: device.label || `Speaker ${index + 1}`,
    }));
}

/**
 * The room's speaker: the audiooutput list, the pick remembered in this
 * browser, and the pick applied to the monitor's AudioContext as it changes and
 * again whenever the monitor opens a new one. A pick whose device is gone, or
 * that the browser refuses, falls back to the default speaker with a note.
 */
export function useOutputDevice(monitor: OutputMonitor): OutputDevice {
  const supported = monitor.outputSupported === true;
  const { contextGeneration = 0, setSinkId } = monitor;
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [known, setKnown] = useState(false);
  const [picked, setPicked] = useState(() => readLocal(OUTPUT_KEY) || "");
  const [failed, setFailed] = useState(false);
  const applied = useRef<{ generation: number; id: string } | null>(null);

  useEffect(() => {
    const mediaDevices = supported ? navigator.mediaDevices : undefined;
    if (!mediaDevices?.enumerateDevices) {
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = labelled(await mediaDevices.enumerateDevices());
        if (!cancelled) {
          setDevices(list);
          setKnown(true);
        }
      } catch {
        if (!cancelled) {
          setKnown(false);
        }
      }
    };
    const onDeviceChange = () => {
      void refresh();
    };
    onDeviceChange();
    mediaDevices.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      cancelled = true;
      mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, [supported]);

  // An empty list is unknown, not "gone": labels can be hidden before permission.
  const gone =
    picked !== "" &&
    known &&
    devices.length > 0 &&
    !devices.some((device) => device.id === picked);
  const selectedId = gone || failed ? "" : picked;

  useEffect(() => {
    if (supported) {
      writeLocal(OUTPUT_KEY, selectedId);
    }
  }, [supported, selectedId]);

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
    setSinkId(selectedId).catch(() => {
      if (!cancelled && selectedId !== "") {
        setFailed(true);
        applied.current = { generation: -1, id: "" };
      }
    });
    return () => {
      cancelled = true;
    };
  }, [supported, setSinkId, selectedId, contextGeneration]);

  const onChange = useCallback((outputId: string) => {
    setFailed(false);
    setPicked(outputId);
  }, []);

  if (!supported) {
    return NO_OUTPUT;
  }
  return {
    supported,
    devices,
    selectedId,
    error: failed
      ? DEVICE_TEXT.outputFailed
      : gone
        ? DEVICE_TEXT.outputGone
        : undefined,
    onChange,
  };
}
