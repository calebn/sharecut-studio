import { create } from "zustand";
import type { RecordSnapshot } from "./types";

type RecordHostState = {
  snapshot: RecordSnapshot | null;
  connected: boolean;
  startPending: boolean;
  setSnapshot: (snap: RecordSnapshot | null) => void;
  setConnected: (connected: boolean) => void;
  setStartPending: (pending: boolean) => void;
};

export const useRecordHostStore = create<RecordHostState>((set) => ({
  snapshot: null,
  connected: false,
  startPending: false,
  setSnapshot: (snapshot) => set({ snapshot }),
  setConnected: (connected) => set({ connected }),
  setStartPending: (startPending) => set({ startPending }),
}));
