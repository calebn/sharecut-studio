import { useCallback, useEffect, useState } from "react";

/** Uncompressed mono 16-bit PCM at the keeper's fixed sample rate. */
export const KEEPER_BYTES_PER_SECOND = 48_000 * 2;
export const STORAGE_HEADROOM_SECONDS = 60 * 60;

export type StorageHeadroom = {
  status: "sufficient" | "low" | "unknown";
  availableBytes: number | null;
  requiredBytes: number;
  message: string;
};

export type StorageHeadroomCheck = StorageHeadroom & {
  refresh: () => Promise<void>;
};

export function assessStorageHeadroom(
  estimate: { quota?: number; usage?: number } | null | undefined = null,
  expectedSeconds = STORAGE_HEADROOM_SECONDS,
): StorageHeadroom {
  const requiredBytes = Math.max(0, expectedSeconds) * KEEPER_BYTES_PER_SECOND;
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
      message:
        "Storage availability could not be checked. Check your device's free space before recording; if upload fails, download the local keeper.",
    };
  }
  const availableBytes = Math.max(0, (quota as number) - (usage as number));
  if (availableBytes < requiredBytes) {
    const minutes = Math.floor(availableBytes / KEEPER_BYTES_PER_SECOND / 60);
    return {
      status: "low",
      availableBytes,
      requiredBytes,
      message: `Local recording storage is low (estimated space for about ${minutes} minutes of audio). Free space before recording; if upload fails, download the local keeper.`,
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
    assessStorageHeadroom(),
  );
  const refresh = useCallback(() => {
    const storage = globalThis.navigator?.storage;
    if (typeof storage?.estimate !== "function") {
      return Promise.resolve();
    }
    return storage
      .estimate()
      .then((result) => {
        setHeadroom(assessStorageHeadroom(result));
      })
      .catch(() => {
        setHeadroom(assessStorageHeadroom());
      });
  }, []);
  useEffect(() => void refresh(), [refresh]);
  return { ...headroom, refresh };
}
