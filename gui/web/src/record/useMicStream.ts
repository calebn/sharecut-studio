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
  const lostRef = useRef(false);
  const acquiringRef = useRef(false);
  const acquisitionGenerationRef = useRef(0);
  const deviceRefreshGenerationRef = useRef(0);
  const fallbackToDefaultRef = useRef(false);

  const retry = useCallback(() => {
    if (!enabled || acquiringRef.current) {
      return;
    }
    acquiringRef.current = true;
    fallbackToDefaultRef.current = lostRef.current && Boolean(deviceId);
    setRetryKey((key) => key + 1);
  }, [deviceId, enabled]);

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
      lostRef.current = false;
      setLost(false);
      return;
    }
    let cancelled = false;
    let acquired: MediaStream | null = null;
    let onTrackEnded: (() => void) | null = null;
    const mediaDevices = navigator.mediaDevices;
    const acquisitionGeneration = acquisitionGenerationRef.current + 1;
    acquisitionGenerationRef.current = acquisitionGeneration;
    acquiringRef.current = true;
    const fallbackToDefault = fallbackToDefaultRef.current;
    fallbackToDefaultRef.current = false;
    const refreshDevices = async () => {
      const refreshGeneration = deviceRefreshGenerationRef.current + 1;
      deviceRefreshGenerationRef.current = refreshGeneration;
      try {
        const list = await mediaDevices.enumerateDevices();
        if (
          !cancelled &&
          refreshGeneration === deviceRefreshGenerationRef.current
        ) {
          setDevices(list.filter((d) => d.kind === "audioinput"));
        }
      } catch {
        if (
          !cancelled &&
          refreshGeneration === deviceRefreshGenerationRef.current
        ) {
          setDevices([]);
        }
      }
    };
    const onDeviceChange = () => {
      const activeTrack = streamRef.current?.getAudioTracks()[0];
      if (activeTrack?.readyState === "ended") {
        onTrackEnded?.();
      }
      void refreshDevices();
    };
    mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    setPending(true);
    setError(null);
    setErrorName(null);
    const start = async () => {
      try {
        let next: MediaStream;
        try {
          next = await navigator.mediaDevices.getUserMedia(
            keeperAudioConstraints(deviceId),
          );
        } catch (err) {
          const name = err instanceof Error ? err.name : "";
          const canUseDefault =
            fallbackToDefault &&
            (name === "NotFoundError" || name === "OverconstrainedError");
          if (!canUseDefault) {
            throw err;
          }
          next = await navigator.mediaDevices.getUserMedia(
            keeperAudioConstraints(),
          );
        }
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
          lostRef.current = true;
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
        lostRef.current = false;
        setLost(false);
        setPending(false);
        setSettledAttempt(resetKey);
        void refreshDevices();
      } catch (err) {
        if (!cancelled) {
          setStream(null);
          setSettingsWarning(null);
          setErrorName(err instanceof Error ? err.name : null);
          setError(err instanceof Error ? err.message : String(err));
          setPending(false);
          setSettledAttempt(resetKey);
        }
      } finally {
        if (acquisitionGenerationRef.current === acquisitionGeneration) {
          acquiringRef.current = false;
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
