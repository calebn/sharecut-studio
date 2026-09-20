import { useEffect, useRef, useState } from "react";
import {
  KEEPER_SETTINGS_WARNING,
  keeperAudioConstraints,
  keeperSettingsMatch,
} from "./keeper/constraints";

export type MicStreamState = {
  stream: MediaStream | null;
  devices: MediaDeviceInfo[];
  error: string | null;
  errorName: string | null;
  settingsWarning: string | null;
  pending: boolean;
  settledAttempt: number;
};

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

export function useMicStream(
  enabled: boolean,
  deviceId: string,
  resetKey = 0,
): MicStreamState {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorName, setErrorName] = useState<string | null>(null);
  const [settingsWarning, setSettingsWarning] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [settledAttempt, setSettledAttempt] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!enabled) {
      stopTracks(streamRef.current);
      streamRef.current = null;
      setStream(null);
      setError(null);
      setErrorName(null);
      setSettingsWarning(null);
      setPending(false);
      setSettledAttempt(resetKey);
      return;
    }
    let cancelled = false;
    let acquired: MediaStream | null = null;
    setPending(true);
    setError(null);
    setErrorName(null);
    const start = async () => {
      try {
        const next = await navigator.mediaDevices.getUserMedia(
          keeperAudioConstraints(deviceId),
        );
        if (cancelled) {
          next.getTracks().forEach((t) => t.stop());
          return;
        }
        acquired = next;
        streamRef.current = next;
        const track = next.getAudioTracks()[0];
        const ok = keeperSettingsMatch(track?.getSettings());
        setSettingsWarning(ok ? null : KEEPER_SETTINGS_WARNING);
        setError(null);
        setErrorName(null);
        setStream(next);
        setPending(false);
        setSettledAttempt(resetKey);
        try {
          const list = await navigator.mediaDevices.enumerateDevices();
          if (!cancelled) {
            setDevices(list.filter((d) => d.kind === "audioinput"));
          }
        } catch {
          if (!cancelled) {
            setDevices([]);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setStream(null);
          setSettingsWarning(null);
          setErrorName(err instanceof Error ? err.name : null);
          setError(err instanceof Error ? err.message : String(err));
          setPending(false);
          setSettledAttempt(resetKey);
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      stopTracks(acquired);
      if (streamRef.current === acquired) {
        streamRef.current = null;
      }
      setStream(null);
    };
  }, [enabled, deviceId, resetKey]);

  return {
    stream,
    devices,
    error,
    errorName,
    settingsWarning,
    pending,
    settledAttempt,
  };
}
