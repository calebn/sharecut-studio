import { withKeeperDeletion } from "./deletionGuard";
import { assertSafePart, KEEPER_OPFS_ROOT } from "./opfsPath";
import {
  type ByteSink,
  type KeeperDirectoryEntry,
  keeperMetaPath,
  keeperWavPath,
  ORPHAN_KEEPER_RETENTION_MS,
  prunedKeeperMarker,
} from "./store";

export const KEEPER_CLEANUP_ENTRY_BUDGET = 64;
export const KEEPER_CLEANUP_RETRY_MS = 30_000;
export const KEEPER_CLEANUP_INTERVAL_MS = 60 * 60_000;
export const KEEPER_CLEANUP_STATE_PATH = `${KEEPER_OPFS_ROOT}/.keeper-cleanup.json`;
const MAX_RETRIES = 16;
const MAX_BACKOFF_MS = 30 * 60_000;

type Frame = {
  parts: string[];
  offset: number;
  lastName: string | null;
  failures: number;
};
type Retry = {
  frame: Frame;
  file: string | null;
  attempts: number;
  at: number;
};
type Checkpoint = {
  version: 1;
  frames: Frame[];
  retries: Retry[];
  nextPassAt: number;
  rescanAt: number | null;
  rescanAttempts: number;
};
type LiveIterator = {
  iterator: AsyncIterator<KeeperDirectoryEntry>;
  offset: number;
  lastName: string | null;
};
const iterators = new WeakMap<ByteSink, Map<string, LiveIterator>>();
const running = new WeakMap<ByteSink, Promise<KeeperCleanupResult>>();

export type KeeperCleanupResult = {
  pruned: number;
  /** Each yielded entry, replay entry, retry and end-of-directory uses one slot. */
  visited: number;
  complete: boolean;
  nextRunAt: number;
};

function rootFrame(): Frame {
  return { parts: [KEEPER_OPFS_ROOT], offset: 0, lastName: null, failures: 0 };
}

function validParts(parts: unknown): parts is string[] {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 4)
    return false;
  if (parts[0] !== KEEPER_OPFS_ROOT) return false;
  try {
    for (const part of parts) {
      if (typeof part !== "string") return false;
      assertSafePart(part);
    }
  } catch {
    return false;
  }
  return (
    parts.length < 3 ||
    (/^(0|[1-9]\d*)$/.test(parts[2]) && Number.isSafeInteger(Number(parts[2])))
  );
}

function validFrame(value: unknown): value is Frame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Frame;
  return (
    validParts(frame.parts) &&
    Number.isSafeInteger(frame.offset) &&
    frame.offset >= 0 &&
    Number.isSafeInteger(frame.failures) &&
    frame.failures >= 0 &&
    (frame.lastName === null || typeof frame.lastName === "string")
  );
}

function decodeCheckpoint(bytes: Uint8Array | null): Checkpoint {
  if (bytes) {
    try {
      const state = JSON.parse(new TextDecoder().decode(bytes)) as Checkpoint;
      if (
        state.version === 1 &&
        Array.isArray(state.frames) &&
        state.frames.length <= 8 &&
        state.frames.every(validFrame) &&
        Array.isArray(state.retries) &&
        state.retries.length <= MAX_RETRIES &&
        state.retries.every(
          (retry) =>
            validFrame(retry.frame) &&
            (retry.file === null || typeof retry.file === "string") &&
            Number.isSafeInteger(retry.attempts) &&
            retry.attempts > 0 &&
            Number.isFinite(retry.at) &&
            retry.at >= 0,
        ) &&
        Number.isFinite(state.nextPassAt) &&
        state.nextPassAt >= 0 &&
        (state.rescanAt === null ||
          (Number.isFinite(state.rescanAt) && state.rescanAt >= 0)) &&
        Number.isSafeInteger(state.rescanAttempts) &&
        state.rescanAttempts >= 0
      )
        return state;
    } catch {
      // A torn/older checkpoint restarts a bounded scan, never authorizes deletion.
    }
  }
  return {
    version: 1,
    frames: [rootFrame()],
    retries: [],
    nextPassAt: 0,
    rescanAt: null,
    rescanAttempts: 0,
  };
}

function save(sink: ByteSink, state: Checkpoint): Promise<void> {
  return sink.write(
    KEEPER_CLEANUP_STATE_PATH,
    new TextEncoder().encode(JSON.stringify(state)),
  );
}

function candidate(parts: string[], file: string): string | null {
  if (parts.length !== 4 || !validParts(parts)) return null;
  const match = /^(0|[1-9]\d*)\.wav$/.exec(file);
  if (!match) return null;
  const segmentIndex = Number(match[1]);
  const takeIndex = Number(parts[2]);
  if (!Number.isSafeInteger(segmentIndex) || !Number.isSafeInteger(takeIndex))
    return null;
  return keeperWavPath({
    sessionId: parts[1],
    takeIndex,
    participantId: parts[3],
    segmentIndex,
  });
}

function descend(frame: Frame, entry: KeeperDirectoryEntry): Frame | null {
  if (entry.kind !== "directory" || frame.parts.length >= 4) return null;
  try {
    assertSafePart(entry.name);
  } catch {
    return null;
  }
  const parts = [...frame.parts, entry.name];
  if (!validParts(parts)) return null; // Room-tone beds and probes are not keepers.
  return { parts, offset: 0, lastName: null, failures: 0 };
}

async function pruneCandidate(
  sink: ByteSink,
  parts: string[],
  file: string,
  canPrune: () => boolean,
  now: number,
): Promise<"pruned" | "retained" | "held"> {
  const wavPath = candidate(parts, file);
  if (!wavPath || !sink.modifiedAt) return "retained";
  const result = await withKeeperDeletion(sink, async () => {
    if (!canPrune()) return "held";
    const metaPath = keeperMetaPath(wavPath);
    const metadata = await sink.read(metaPath);
    // Any metadata, including zero-byte/torn metadata, protects pending/finalized audio.
    if (metadata !== null && !prunedKeeperMarker(metadata, wavPath))
      return "retained";
    const modified = await sink.modifiedAt?.(wavPath);
    if (
      modified == null ||
      !Number.isFinite(modified) ||
      now - modified < ORPHAN_KEEPER_RETENTION_MS
    )
      return "retained";
    if (!canPrune()) return "held";
    await sink.write(
      metaPath,
      new TextEncoder().encode(
        JSON.stringify({
          pruned: true,
          sessionId: parts[1],
          takeIndex: Number(parts[2]),
          participantId: parts[3],
          segmentIndex: Number(file.slice(0, -4)),
        }),
      ),
    );
    await sink.remove(wavPath);
    return "pruned";
  });
  return result.held ? "held" : result.value;
}

function postpone(retry: Retry, now: number): void {
  retry.at =
    now +
    Math.min(
      MAX_BACKOFF_MS,
      KEEPER_CLEANUP_RETRY_MS * 2 ** Math.min(10, retry.attempts - 1),
    );
}

function enqueueRetry(state: Checkpoint, retry: Retry, now: number): void {
  if (
    state.retries.some(
      (queued) =>
        queued.file === retry.file &&
        queued.frame.parts.join("/") === retry.frame.parts.join("/"),
    )
  )
    return;
  if (state.retries.length < MAX_RETRIES) {
    postpone(retry, now);
    state.retries.push(retry);
  } else if (state.rescanAt === null) {
    // A bounded retry queue must never pin the scan behind permanent failures.
    // Retained files remain on disk; a persisted backoff rescan revisits overflow.
    state.rescanAttempts += 1;
    retry.attempts = state.rescanAttempts;
    postpone(retry, now);
    state.rescanAt = retry.at;
  }
}

function scheduleFrame(state: Checkpoint, frame: Frame, now: number): void {
  if (state.frames.length < 8) {
    state.frames.push(frame);
    return;
  }
  enqueueRetry(state, { frame, file: null, attempts: 1, at: 0 }, now);
}

async function scan(
  sink: ByteSink,
  canPrune: () => boolean,
  now: number,
): Promise<KeeperCleanupResult> {
  const state = decodeCheckpoint(await sink.read(KEEPER_CLEANUP_STATE_PATH));
  const result: KeeperCleanupResult = {
    pruned: 0,
    visited: 0,
    complete: false,
    nextRunAt: now + KEEPER_CLEANUP_RETRY_MS,
  };
  if (
    !state.frames.length &&
    !state.retries.length &&
    state.rescanAt === null &&
    state.nextPassAt > now
  )
    return {
      ...result,
      complete: state.retries.length === 0,
      nextRunAt: state.nextPassAt,
    };
  if (
    !state.frames.length &&
    (state.nextPassAt <= now ||
      (state.rescanAt !== null && state.rescanAt <= now))
  ) {
    state.frames.push(rootFrame());
    state.nextPassAt = now + KEEPER_CLEANUP_INTERVAL_MS;
    if (state.rescanAt !== null && state.rescanAt <= now) state.rescanAt = null;
  }
  let live = iterators.get(sink);
  if (!live) {
    live = new Map();
    iterators.set(sink, live);
  }
  // Retries use at most half a slice; failed files cannot starve new sessions.
  for (const retry of [...state.retries]) {
    if (!canPrune() || result.visited >= KEEPER_CLEANUP_ENTRY_BUDGET / 2) break;
    if (retry.at > now) continue;
    if (retry.file === null && state.frames.length >= 8) continue;
    result.visited += 1;
    if (retry.file === null) {
      retry.frame.failures = retry.attempts;
      const frame = retry.frame;
      state.retries.splice(state.retries.indexOf(retry), 1);
      scheduleFrame(state, frame, now);
    } else {
      try {
        const outcome = await pruneCandidate(
          sink,
          retry.frame.parts,
          retry.file,
          canPrune,
          now,
        );
        if (outcome === "held") {
          retry.attempts += 1;
          postpone(retry, now);
        } else {
          if (outcome === "pruned") result.pruned += 1;
          state.retries.splice(state.retries.indexOf(retry), 1);
        }
      } catch {
        retry.attempts += 1;
        postpone(retry, now);
      }
    }
    await save(sink, state);
  }
  while (
    state.frames.length &&
    canPrune() &&
    result.visited < KEEPER_CLEANUP_ENTRY_BUDGET
  ) {
    const frame = state.frames[state.frames.length - 1];
    const path = frame.parts.join("/");
    result.visited += 1;
    try {
      let current = live.get(path);
      if (!current || current.offset > frame.offset) {
        if (!sink.entries) break;
        current = {
          iterator: sink.entries(path)[Symbol.asyncIterator](),
          offset: 0,
          lastName: null,
        };
        live.set(path, current);
      }
      const next = await current.iterator.next();
      if (next.done) {
        state.frames.pop();
        live.delete(path);
      } else {
        current.offset += 1;
        current.lastName = next.value.name;
        if (current.offset <= frame.offset) {
          // OPFS cannot seek. Replay is lazy and charged against this slice.
          // Validate the last name so order changes restart this directory.
          if (
            current.offset === frame.offset &&
            current.lastName !== frame.lastName
          ) {
            frame.offset = 0;
            frame.lastName = null;
            live.delete(path);
            await save(sink, state);
          }
          continue;
        }
        const entry = next.value;
        const child = descend(frame, entry);
        let outcome: "pruned" | "retained" | "held" = "retained";
        const queued = state.retries.find(
          (retry) =>
            retry.file === entry.name && retry.frame.parts.join("/") === path,
        );
        try {
          if (entry.kind === "file" && (!queued || queued.at <= now))
            outcome = await pruneCandidate(
              sink,
              frame.parts,
              entry.name,
              canPrune,
              now,
            );
        } catch {
          outcome = "held"; // Retry this file without abandoning later entries.
        }
        if (outcome === "held") {
          const retry: Retry = {
            frame: { ...frame },
            file: entry.name,
            attempts: 1,
            at: 0,
          };
          enqueueRetry(state, retry, now);
        }
        if (outcome === "pruned") result.pruned += 1;
        frame.offset = current.offset;
        frame.lastName = current.lastName;
        frame.failures = 0;
        if (child) scheduleFrame(state, child, now);
      }
      await save(sink, state); // Handling one entry is the durable progress boundary.
    } catch {
      live.delete(path);
      const retry: Retry = {
        frame: { ...frame, parts: [...frame.parts] },
        file: null,
        attempts: frame.failures + 1,
        at: 0,
      };
      enqueueRetry(state, retry, now);
      state.frames.pop();
      await save(sink, state);
    }
  }
  result.complete =
    state.frames.length === 0 &&
    state.retries.length === 0 &&
    state.rescanAt === null;
  if (!state.frames.length && state.nextPassAt <= now)
    state.nextPassAt = now + KEEPER_CLEANUP_INTERVAL_MS;
  if (result.complete) state.rescanAttempts = 0;
  result.nextRunAt = state.frames.length
    ? now + KEEPER_CLEANUP_RETRY_MS
    : Math.min(
        state.nextPassAt,
        state.rescanAt ?? Infinity,
        ...state.retries.map((retry) => retry.at),
      );
  await save(sink, state);
  if (result.complete) iterators.delete(sink);
  return result;
}

/** One bounded origin-wide maintenance slice; never awaits host status/upload. */
export function pruneExpiredKeeperWavs(
  sink: ByteSink,
  canPrune: () => boolean,
  now = Date.now(),
): Promise<KeeperCleanupResult> {
  const pending = running.get(sink);
  if (pending) return pending;
  const idle: KeeperCleanupResult = {
    pruned: 0,
    visited: 0,
    complete: false,
    nextRunAt: now + KEEPER_CLEANUP_RETRY_MS,
  };
  if (!sink.entries || !sink.modifiedAt || !canPrune())
    return Promise.resolve(idle);
  const locks = sink.deletionLockName ? navigator.locks : null;
  if (sink.deletionLockName && !locks) return Promise.resolve(idle);
  const work =
    locks && sink.deletionLockName
      ? locks.request(
          `${sink.deletionLockName}-maintenance`,
          { mode: "exclusive", ifAvailable: true },
          (lock) => (lock ? scan(sink, canPrune, now) : idle),
        )
      : scan(sink, canPrune, now);
  const tracked = work.finally(() => running.delete(sink));
  running.set(sink, tracked);
  return tracked;
}
