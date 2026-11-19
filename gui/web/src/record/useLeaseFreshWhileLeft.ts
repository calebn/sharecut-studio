import { useCallback, useEffect, useRef, useState } from "react";
import { loadRecordParticipant } from "../services/offlineQueue/offlineStore";
import { leaseKnownYoungEnough, msUntilLeaseStale } from "./participantLease";

const MAX_TIMER_MS = 2 ** 31 - 1;

export function useLeaseFreshWhileLeft(token: string, left: boolean) {
  const [young, setYoung] = useState(false);
  const entry =
    useRef<Awaited<ReturnType<typeof loadRecordParticipant>>>(undefined);
  useEffect(() => {
    setYoung(false);
    entry.current = undefined;
    if (!left) {
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    loadRecordParticipant(token).then(
      (cached) => {
        if (!live) {
          return;
        }
        entry.current = cached;
        const wait = msUntilLeaseStale(cached, Date.now());
        if (wait === null) {
          return;
        }
        setYoung(true);
        timer = setTimeout(() => setYoung(false), Math.min(wait, MAX_TIMER_MS));
      },
      () => undefined,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [token, left]);
  const stillFresh = useCallback(
    () => leaseKnownYoungEnough(entry.current, Date.now()),
    [],
  );
  return { leaseFresh: left && young, leaseStillFresh: stillFresh };
}
