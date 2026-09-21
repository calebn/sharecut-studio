import { useCallback, useEffect, useRef, useState } from "react";
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
  lost: boolean;
  retry: () => void;
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
  const [lost, setLost] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);

  const retry = useCallback(() => {
    if (enabled) {
      setRetryKey((key) => key + 1);
    }
  }, [enabled]);

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
      setLost(false);
      return;
    }
    let cancelled = false;
    let acquired: MediaStream | null = null;
    let onTrackEnded: (() => void) | null = null;
    const mediaDevices = navigator.mediaDevices;
    const onDeviceChange = () => {
      const activeTrack = streamRef.current?.getAudioTracks()[0];
      if (activeTrack?.readyState === "ended") {
        onTrackEnded?.();
      }
      void mediaDevices
        .enumerateDevices()
        .then((list) => {
          if (!cancelled) {
            setDevices(list.filter((d) => d.kind === "audioinput"));
          }
        })
        .catch(() => undefined);
    };
    mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
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
        onTrackEnded = () => {
          if (cancelled || streamRef.current !== next) {
            return;
          }
          streamRef.current = null;
          setStream(null);
          setLost(true);
          setPending(false);
        };
        track?.addEventListener?.("ended", onTrackEnded);
        if (track?.readyState === "ended") {
          onTrackEnded();
          return;
        }
        const ok = keeperSettingsMatch(track?.getSettings());
        setSettingsWarning(ok ? null : KEEPER_SETTINGS_WARNING);
        setError(null);
        setErrorName(null);
        setStream(next);
        setLost(false);
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
      mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      if (onTrackEnded) {
        acquired
          ?.getAudioTracks()[0]
          ?.removeEventListener?.("ended", onTrackEnded);
      }
      stopTracks(acquired);
      if (streamRef.current === acquired) {
        streamRef.current = null;
      }
      setStream(null);
    };
  }, [enabled, deviceId, resetKey, retryKey]);

  return {
    stream,
    devices,
    error,
    errorName,
    settingsWarning,
    pending,
    settledAttempt,
    lost,
    retry,
  };
}
