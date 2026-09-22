import { create } from "zustand";
import type { RecordSnapshot } from "./types";

type RecordHostState = {
  snapshot: RecordSnapshot | null;
  connected: boolean;
  startPending: boolean;
  startInFlight: boolean;
  startBaselineNs: number | null;
  setSnapshot: (snap: RecordSnapshot | null) => void;
  setConnected: (connected: boolean) => void;
  beginStart: () => void;
  setStartInFlight: (inFlight: boolean) => void;
  finishStartRisk: (verified: boolean) => void;
};

export const useRecordHostStore = create<RecordHostState>((set) => ({
  snapshot: null,
  connected: false,
  startPending: false,
  startInFlight: false,
  startBaselineNs: null,
  setSnapshot: (snapshot) =>
    set((state) => {
      const fresh =
        snapshot !== null &&
        (state.startBaselineNs === null ||
          (snapshot.server_time_ns != null &&
            snapshot.server_time_ns > state.startBaselineNs));
      return {
        snapshot,
        startPending:
          state.startPending && !state.startInFlight && fresh
            ? false
            : state.startPending,
      };
    }),
  setConnected: (connected) => set({ connected }),
  beginStart: () =>
    set((state) => ({
      startPending: true,
      startInFlight: true,
      startBaselineNs: state.snapshot?.server_time_ns ?? null,
    })),
  setStartInFlight: (startInFlight) => set({ startInFlight }),
  finishStartRisk: (verified) =>
    set((state) => ({
      startInFlight: false,
      startPending: verified ? false : state.startPending,
    })),
}));
