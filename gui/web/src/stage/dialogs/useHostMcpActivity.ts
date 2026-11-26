import { useState } from "react";
import { fetchHostMcpActivity, type HostMcpActivity } from "../../api";
import { usePollWhileVisible } from "../../hooks/usePollWhileVisible";
import { ApiError } from "../../utils/apiError";
import {
  ACTIVITY_POLL_MS,
  ACTIVITY_TICK_MS,
  type ActivityState,
  activityFromResponse,
} from "./hostMcp";

export type { HostMcpActivity };

const STOP_STATUSES: readonly (number | null)[] = [401, 403, 404];
const UNKNOWN: ActivityState = { kind: "unknown" };

/**
 * What the host last said about its MCP address, and a clock (`performance.now()`) that
 * keeps the minutes counting up between answers. Asks only while `poll` is true
 * (open, a live address, no fixed preview) and the tab is visible; `open` going false
 * forgets the answer so the next open starts blank. A fixed `preview` is shown as is.
 */
export function useHostMcpActivity({
  open,
  poll,
  preview,
}: {
  open: boolean;
  poll: boolean;
  preview?: HostMcpActivity;
}): { activity: ActivityState; now: number } {
  const [activity, setActivity] = useState<ActivityState>(UNKNOWN);
  const [now, setNow] = useState(() => performance.now());
  if (!open && activity.kind !== "unknown") setActivity(UNKNOWN);

  usePollWhileVisible({
    enabled: poll,
    intervalMs: ACTIVITY_POLL_MS,
    fetcher: fetchHostMcpActivity,
    onResult: (answer) => {
      const at = performance.now();
      setNow(at);
      setActivity(activityFromResponse(answer, at));
      return answer.mounted ? undefined : "stop";
    },
    // A failed check keeps what the dialog already shows. A refusal will not change, so stop asking.
    onError: (error) =>
      error instanceof ApiError && STOP_STATUSES.includes(error.status)
        ? "stop"
        : undefined,
  });
  // Count the minutes up between answers; it also catches up after a hidden tab.
  usePollWhileVisible({
    enabled: poll && activity.kind === "used",
    intervalMs: ACTIVITY_TICK_MS,
    fetcher: () => Promise.resolve(performance.now()),
    onResult: (at) => {
      setNow(at);
      return undefined;
    },
    onError: () => undefined,
  });

  return {
    activity: preview ? activityFromResponse(preview, now) : activity,
    now,
  };
}
