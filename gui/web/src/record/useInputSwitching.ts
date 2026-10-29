import { useState } from "react";
import type { MicPermissionStatus } from "./micPermission";

type Opened = { stream: MediaStream; deviceId: string };

/** True while a stream that was open on another input is re-opening on the picked one. */
export function useInputSwitching(
  stream: MediaStream | null,
  status: MicPermissionStatus,
  deviceId: string,
): boolean {
  const [opened, setOpened] = useState<Opened | null>(null);
  const waiting =
    status === "prompting" || status === "idle" || status === "granted";
  if (stream && opened?.stream !== stream) {
    setOpened({ stream, deviceId });
  } else if (!stream && opened && !waiting) {
    setOpened(null);
  }
  return !stream && !!opened && opened.deviceId !== deviceId && waiting;
}
