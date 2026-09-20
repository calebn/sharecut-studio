export type RecordSignalDescription = {
  type: RTCSdpType;
  sdp: string;
};

export type RecordSignal = {
  type: "Signal";
  plane?: "record";
  from: string;
  to: string;
  connected_wall_ms?: number;
  description?: RecordSignalDescription;
  candidate?: RTCIceCandidateInit | null;
};

export type SignalPayload = {
  to: string;
  connected_wall_ms?: number;
  description?: RecordSignalDescription;
  candidate?: RTCIceCandidateInit | null;
};

const listeners = new Set<(msg: RecordSignal) => void>();
const backlog = new Map<string, RecordSignal[]>();
const BACKLOG_MAX_PER_PEER = 64;

function peerKey(from: string, to: string): string {
  return `${from}\0${to}`;
}

function hasXorPayload(msg: RecordSignal): boolean {
  return Boolean(msg.description) !== Boolean(msg.candidate);
}

export function subscribeRecordSignal(
  listener: (msg: RecordSignal) => void,
): () => void {
  listeners.add(listener);
  const queued = [...backlog.values()].flat();
  backlog.clear();
  for (const msg of queued) {
    listener(msg);
  }
  return () => {
    listeners.delete(listener);
  };
}

export function emitRecordSignal(msg: RecordSignal): void {
  if (!msg.from || !msg.to || !hasXorPayload(msg)) {
    return;
  }
  if (recordE2eWindow()) {
    const w = window as unknown as { __recordSignalCount?: number };
    w.__recordSignalCount = (w.__recordSignalCount ?? 0) + 1;
  }
  if (listeners.size === 0) {
    const key = peerKey(msg.from, msg.to);
    const queue = backlog.get(key) ?? [];
    queue.push(msg);
    while (queue.length > BACKLOG_MAX_PER_PEER) {
      const dropAt = queue.findIndex(
        (row) => row.candidate && !row.description,
      );
      queue.splice(dropAt === -1 ? 0 : dropAt, 1);
    }
    backlog.set(key, queue);
    return;
  }
  for (const listener of listeners) {
    listener(msg);
  }
}

function recordE2eWindow(): boolean {
  try {
    return Boolean(
      (window as unknown as { __SHARECUT_E2E?: boolean }).__SHARECUT_E2E,
    );
  } catch {
    return false;
  }
}

export function isRecordSignal(msg: unknown): msg is RecordSignal {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const row = msg as Record<string, unknown>;
  if (
    row.type !== "Signal" ||
    typeof row.from !== "string" ||
    typeof row.to !== "string"
  ) {
    return false;
  }
  return Boolean(row.description) !== Boolean(row.candidate);
}
