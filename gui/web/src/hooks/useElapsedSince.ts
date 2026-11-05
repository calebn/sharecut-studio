import { useEffect, useState, useSyncExternalStore } from "react";
import {
  createElapsedSample,
  createReceiptElapsedSample,
} from "./sampledClocks";

export function useElapsedSince(startMs: number | null, active: boolean) {
  const [clock] = useState(createElapsedSample);
  const nowMs = useSyncExternalStore(clock.subscribe, clock.getSnapshot);
  useEffect(() => {
    clock.setStart(startMs);
  }, [clock, startMs]);
  useEffect(() => clock.connect(active), [clock, active]);
  return startMs === null ? 0 : Math.max(0, nowMs - startMs);
}

export function useElapsedFromReceipt(
  identity: object | null,
  active: boolean,
) {
  const [clock] = useState(createReceiptElapsedSample);
  const sample = useSyncExternalStore(clock.subscribe, clock.getSnapshot);
  useEffect(() => {
    if (identity !== null) clock.receive();
  }, [clock, identity]);
  useEffect(() => {
    clock.sampleOrigin(sample.origin);
  }, [clock, sample.origin]);
  useEffect(() => clock.connect(active), [clock, active]);
  return sample.origin === null ? 0 : Math.max(0, sample.now - sample.origin);
}
