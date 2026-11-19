import { useEffect, useState } from "react";
import { loadRecordParticipant } from "../services/offlineQueue/offlineStore";
import { leaseKnownYoungEnough } from "./participantLease";

export function useLeaseFreshWhileLeft(token: string, left: boolean): boolean {
  const [young, setYoung] = useState(false);
  useEffect(() => {
    if (!left) {
      return;
    }
    let live = true;
    loadRecordParticipant(token).then(
      (entry) => {
        if (live) {
          setYoung(leaseKnownYoungEnough(entry, Date.now()));
        }
      },
      () => {
        if (live) {
          setYoung(false);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [token, left]);
  return left && young;
}
