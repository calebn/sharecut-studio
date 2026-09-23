import { useCallback, useEffect, useRef, useState } from "react";
import { KEEPER_BYTES_PER_SECOND } from "./keeper/pcm";
import { STORAGE_UNKNOWN_COPY, storageLowCopy } from "./types";

export const STORAGE_HEADROOM_SECONDS = 60 * 60;

export type StorageHeadroomStatus =
  | "checking"
  | "sufficient"
  | "low"
  | "unknown";

export type StorageHeadroom = {
  status: StorageHeadroomStatus;
  availableBytes: number | null;
  requiredBytes: number;
  message: string;
};

export type StorageHeadroomCheck = StorageHeadroom & {
  refresh: () => Promise<void>;
};

function requiredBytesFor(expectedSeconds: number): number {
  return Math.max(0, expectedSeconds) * KEEPER_BYTES_PER_SECOND;
}

/** Silent initial state while `navigator.storage.estimate()` is in flight. */
export function checkingStorageHeadroom(
  expectedSeconds = STORAGE_HEADROOM_SECONDS,
): StorageHeadroom {
  return {
    status: "checking",
    availableBytes: null,
    requiredBytes: requiredBytesFor(expectedSeconds),
    message: "",
  };
}

export function assessStorageHeadroom(
  estimate: { quota?: number; usage?: number } | null | undefined = null,
  expectedSeconds = STORAGE_HEADROOM_SECONDS,
): StorageHeadroom {
  const requiredBytes = requiredBytesFor(expectedSeconds);
  const quota = estimate?.quota;
  const usage = estimate?.usage;
  if (
    !Number.isFinite(quota) ||
    !Number.isFinite(usage) ||
    (quota as number) < 0 ||
    (usage as number) < 0
  ) {
    return {
      status: "unknown",
      availableBytes: null,
      requiredBytes,
      message: STORAGE_UNKNOWN_COPY,
    };
  }
  const availableBytes = Math.max(0, (quota as number) - (usage as number));
  if (availableBytes < requiredBytes) {
    const minutes = Math.floor(availableBytes / KEEPER_BYTES_PER_SECOND / 60);
    return {
      status: "low",
      availableBytes,
      requiredBytes,
      message: storageLowCopy(minutes),
    };
  }
  return {
    status: "sufficient",
    availableBytes,
    requiredBytes,
    message: "",
  };
}

export function useStorageHeadroom(): StorageHeadroomCheck {
  const [headroom, setHeadroom] = useState<StorageHeadroom>(() =>
    checkingStorageHeadroom(),
  );
  // Only the latest refresh may commit, and never after unmount: an older
  // estimate taken before keeper reclaim must not overwrite a newer one.
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    latest.current += 1;
    const request = latest.current;
    const commit = (next: StorageHeadroom) => {
      if (mounted.current && request === latest.current) {
        setHeadroom(next);
      }
    };
    const storage = globalThis.navigator?.storage;
    if (typeof storage?.estimate !== "function") {
      commit(assessStorageHeadroom());
      return;
    }
    try {
      commit(assessStorageHeadroom(await storage.estimate()));
    } catch {
      commit(assessStorageHeadroom());
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  return { ...headroom, refresh };
}
