import { create } from "zustand";
import type { RecordSnapshot } from "./types";

type RecordHostState = {
  snapshot: RecordSnapshot | null;
  connected: boolean;
  setSnapshot: (snap: RecordSnapshot | null) => void;
  setConnected: (connected: boolean) => void;
};

export const useRecordHostStore = create<RecordHostState>((set) => ({
  snapshot: null,
  connected: false,
  setSnapshot: (snapshot) => set({ snapshot }),
  setConnected: (connected) => set({ connected }),
}));
