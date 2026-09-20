import type { RecordRole, RecordRoomState } from "../types";

export type KeeperGate = {
  role: RecordRole;
  consented: boolean | null;
  roomState: RecordRoomState;
  takeIndex: number;
  recordingMs: number;
  muted: boolean;
};

export type OpenSegment = {
  takeIndex: number;
  segmentIndex: number;
  joinOffsetMs: number;
};

export type KeeperCursor = {
  takeIndex: number;
  nextSegmentIndex: number;
  open: OpenSegment | null;
};

export type SegmentPlan = {
  close: boolean;
  open: OpenSegment | null;
  write: boolean;
  muted: boolean;
  cursor: KeeperCursor;
};

export function emptyKeeperCursor(): KeeperCursor {
  return { takeIndex: -1, nextSegmentIndex: 0, open: null };
}

export function planKeeperSegment(
  gate: KeeperGate,
  cursor: KeeperCursor,
): SegmentPlan {
  const recorded = gate.role === "host" || gate.role === "guest";
  const allowed = recorded && gate.consented === true;
  const shouldWrite = allowed && gate.roomState === "recording";

  let takeIndex = cursor.takeIndex;
  let nextSegmentIndex = cursor.nextSegmentIndex;
  if (gate.takeIndex !== cursor.takeIndex) {
    takeIndex = gate.takeIndex;
    nextSegmentIndex = 0;
  }

  if (!shouldWrite) {
    return {
      close: cursor.open !== null,
      open: null,
      write: false,
      muted: false,
      cursor: { takeIndex, nextSegmentIndex, open: null },
    };
  }

  if (cursor.open && cursor.open.takeIndex === gate.takeIndex) {
    return {
      close: false,
      open: null,
      write: true,
      muted: gate.muted,
      cursor,
    };
  }

  const opened: OpenSegment = {
    takeIndex: gate.takeIndex,
    segmentIndex: nextSegmentIndex,
    joinOffsetMs: Math.max(0, Math.round(gate.recordingMs)),
  };
  return {
    close: cursor.open !== null,
    open: opened,
    write: true,
    muted: gate.muted,
    cursor: {
      takeIndex: gate.takeIndex,
      nextSegmentIndex: nextSegmentIndex + 1,
      open: opened,
    },
  };
}
