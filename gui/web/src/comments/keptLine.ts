import type { HostCause } from "../state/hostReach";

export function keptLine(
  noun: "Comment" | "Reply" | "Trim",
  cause: HostCause | null,
) {
  const when =
    cause === "host"
      ? "when the host is back"
      : cause === "device"
        ? "when you're back online"
        : "when you can reach the host";
  return `${noun} kept. It sends ${when}.`;
}
