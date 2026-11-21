import type { HostCause } from "../state/hostReach";

/** What a guest reads once their words are kept on this device, by why the host cannot be reached. */
export function keptLine(noun: "Comment" | "Reply", cause: HostCause | null) {
  const when =
    cause === "host"
      ? "when the host is back"
      : cause === "device"
        ? "when you're back online"
        : "when you can reach the host";
  return `${noun} kept. It sends ${when}.`;
}
