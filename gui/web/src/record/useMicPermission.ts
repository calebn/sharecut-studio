import { useCallback, useEffect, useRef, useState } from "react";
import {
  type MicPermissionStatus,
  microphonePermissionsQuery,
  statusFromGumError,
} from "./micPermission";
import { useMicStream } from "./useMicStream";

export type MicPermissionState = {
  status: MicPermissionStatus;
  request: () => void;
  retry: () => void;
  stream: MediaStream | null;
  devices: MediaDeviceInfo[];
  error: string | null;
  settingsWarning: string | null;
  lost: boolean;
};

type PermissionStatusHandle = {
  state: PermissionState;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

/**
 * Explicit mic grant before `useMicStream` runs. One getUserMedia path.
 */
export function useMicPermission(
  enabled: boolean,
  deviceId: string,
): MicPermissionState {
  const [wantStream, setWantStream] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [queryDenied, setQueryDenied] = useState(false);
  const [hadGrant, setHadGrant] = useState(false);
  const attemptRef = useRef(0);
  const settledRef = useRef(0);
  const streamOn = enabled && wantStream && !queryDenied;
  const mic = useMicStream(streamOn, deviceId, attempt);
  const micLost = mic.lost;
  const retryMic = mic.retry;
  settledRef.current = mic.settledAttempt;

  useEffect(() => {
    if (!enabled) {
      setWantStream(false);
      setQueryDenied(false);
      setHadGrant(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const perms = microphonePermissionsQuery();
    if (!perms) {
      return;
    }
    let cancelled = false;
    const statusRef = { current: null as PermissionStatusHandle | null };
    const apply = (state: PermissionState) => {
      if (!cancelled) {
        setQueryDenied(state === "denied");
      }
    };
    const onChange = () => {
      if (statusRef.current) {
        apply(statusRef.current.state);
      }
    };
    void perms
      .query({ name: "microphone" })
      .then((result) => {
        statusRef.current = result;
        if (cancelled) {
          result.removeEventListener?.("change", onChange);
          return;
        }
        apply(result.state);
        result.addEventListener?.("change", onChange);
      })
      .catch(() => {
        // Safari and others reject an unsupported name.
      });
    return () => {
      cancelled = true;
      statusRef.current?.removeEventListener?.("change", onChange);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || queryDenied) {
      setHadGrant(false);
      return;
    }
    if (mic.error && !mic.pending) {
      setHadGrant(false);
      return;
    }
    if (mic.stream) {
      setHadGrant(true);
    }
  }, [enabled, queryDenied, mic.stream, mic.error, mic.pending]);

  const beginAcquire = useCallback(() => {
    if (!enabled) {
      return;
    }
    if (attemptRef.current !== settledRef.current) {
      return;
    }
    attemptRef.current += 1;
    setAttempt(attemptRef.current);
    setQueryDenied(false);
    setWantStream(true);
  }, [enabled]);

  const retry = useCallback(() => {
    if (micLost) {
      retryMic();
      return;
    }
    beginAcquire();
  }, [beginAcquire, micLost, retryMic]);

  let status: MicPermissionStatus = "idle";
  if (!enabled) {
    status = "idle";
  } else if (queryDenied) {
    status = "denied";
  } else if (mic.lost) {
    status = "lost";
  } else if (attemptRef.current !== mic.settledAttempt && !mic.stream) {
    status = "prompting";
  } else if (wantStream && !mic.pending) {
    const mapped = mic.errorName ? statusFromGumError(mic.errorName) : null;
    if (mapped) {
      status = mapped;
    } else if (mic.error) {
      status = "error";
    } else if (mic.stream || hadGrant) {
      status = "granted";
    } else {
      status = "prompting";
    }
  } else if (mic.stream || (hadGrant && (mic.pending || !mic.error))) {
    status = "granted";
  } else if (wantStream) {
    status = "prompting";
  }

  return {
    status,
    request: beginAcquire,
    retry,
    stream: mic.stream,
    devices: mic.devices,
    error: mic.error,
    settingsWarning: mic.settingsWarning,
    lost: mic.lost,
  };
}
