import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Suspense, startTransition, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../../test/deferred";
import { recordSnapshot } from "../../test/fixtures";
import {
  type AcceptedRecordSnapshot,
  EMPTY_ACCEPTED_RECORD_SNAPSHOT,
} from "../types";
import { openKeeperTap } from "./graph";
import { KeeperSession } from "./session";
import {
  keeperMetaPath,
  keeperWavPath,
  MemorySink,
  parseKeeperMeta,
} from "./store";
import { useKeeperCapture } from "./useKeeperCapture";

const graph = vi.hoisted(() => ({ emit: (_pcm: Float32Array) => {} }));
vi.mock("./graph", () => ({
  openKeeperTap: vi.fn(
    async (
      _stream: MediaStream,
      onPcm: (pcm: Float32Array, rate: number) => void,
    ) => {
      graph.emit = (pcm) => onPcm(pcm, 48_000);
      return { stop: vi.fn(), resume: async () => "running" as const };
    },
  ),
}));

const heldOperation = vi.hoisted(() => ({
  stop: null as Promise<void> | null,
}));

vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    KeeperSession: class extends actual.KeeperSession {
      override async apply(
        gate: Parameters<InstanceType<typeof actual.KeeperSession>["apply"]>[0],
      ) {
        if (gate.roomState === "stopped" && heldOperation.stop)
          await heldOperation.stop;
        await super.apply(gate);
      }
    },
  };
});

beforeEach(() => {
  heldOperation.stop = null;
  vi.mocked(openKeeperTap).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("retains the first-observed recording snapshot time through delayed commit of the same object", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  const snapshot = recordSnapshot({
    session_id: "clock-room",
    state: "recording",
    take_index: 0,
    recording_ms: 300,
  });
  const sink = new MemorySink();
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  const apply = vi.spyOn(KeeperSession.prototype, "apply");
  const pending = deferred();
  const consumedGate = vi.spyOn(pending.promise, "then");
  let ready = false;
  function Probe({
    acceptedSnapshot,
  }: {
    acceptedSnapshot: AcceptedRecordSnapshot;
  }) {
    const capture = useKeeperCapture({
      enabled: true,
      role: "guest",
      acceptedSnapshot,
      participantId: "p_g",
      muted: false,
      consented: true,
      stream,
      sink,
    });
    if (acceptedSnapshot.snapshot && !ready) throw pending.promise;
    return (
      <p>{capture.recordingLocally ? "Recording locally" : "Idle keeper"}</p>
    );
  }
  function Host() {
    const [current, setCurrent] = useState<AcceptedRecordSnapshot>(
      EMPTY_ACCEPTED_RECORD_SNAPSHOT,
    );
    return (
      <>
        <button
          type="button"
          onClick={() => {
            const next = { snapshot, acceptedAtWallMs: Date.now() };
            startTransition(() => setCurrent(next));
          }}
        >
          Observe snapshot
        </button>
        <Suspense fallback={<p>Loading keeper</p>}>
          <Probe acceptedSnapshot={current} />
        </Suspense>
      </>
    );
  }
  const view = render(<Host />);
  expect(screen.getByText("Idle keeper")).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Observe snapshot" }));
  });
  expect(consumedGate).toHaveBeenCalled();
  expect(screen.queryByText("Loading keeper")).not.toBeInTheDocument();
  expect(screen.getByText("Idle keeper")).toBeInTheDocument();
  expect(apply).not.toHaveBeenCalled();
  vi.setSystemTime(5000);
  await act(async () => {
    ready = true;
    pending.resolve();
  });
  await screen.findByText("Recording locally");
  await waitFor(() =>
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ roomState: "recording", recordingMs: 4300 }),
    ),
  );
  const path = keeperWavPath({
    sessionId: "clock-room",
    participantId: "p_g",
    takeIndex: 0,
    segmentIndex: 0,
  });
  await waitFor(() => expect(openKeeperTap).toHaveBeenCalled());
  await act(async () => graph.emit(new Float32Array(480).fill(0.1)));
  await waitFor(() =>
    expect((sink.files.get(path)?.length ?? 0) > 44).toBe(true),
  );
  view.unmount();
  await waitFor(async () =>
    expect(
      parseKeeperMeta(await sink.read(keeperMetaPath(path)))?.complete,
    ).toBe(true),
  );
  const meta = parseKeeperMeta(await sink.read(keeperMetaPath(path)));
  expect(meta).toMatchObject({ complete: true, joinOffsetMs: 4300 });
});

it("keeps the committed reporter during a held Stop and publishes a later committed reporter", async () => {
  const first = vi.fn<(takeIndex: number, segments: number) => void>();
  const second = vi.fn<(takeIndex: number, segments: number) => void>();
  const sink = new MemorySink();
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  const paused = recordSnapshot({
    session_id: "report-room",
    state: "paused",
    take_index: 0,
  });
  const stopped = { ...paused, state: "stopped" as const };
  const pausedAccepted = { snapshot: paused, acceptedAtWallMs: Date.now() };
  const stop = deferred();
  const pending = deferred();
  const consumedGate = vi.spyOn(pending.promise, "then");
  heldOperation.stop = stop.promise;
  const applied = vi.spyOn(KeeperSession.prototype, "apply");
  let ready = false;
  function Probe({
    acceptedSnapshot,
    reporter,
    tentative,
  }: {
    acceptedSnapshot: AcceptedRecordSnapshot;
    reporter: (takeIndex: number, segments: number) => void;
    tentative: boolean;
  }) {
    useKeeperCapture({
      enabled: true,
      role: "guest",
      acceptedSnapshot,
      participantId: "p_g",
      muted: false,
      consented: true,
      stream,
      sink,
      reportSegments: reporter,
    });
    if (tentative && !ready) throw pending.promise;
    return <p>Committed reporter</p>;
  }
  function Host() {
    const [current, setCurrent] = useState({
      acceptedSnapshot: pausedAccepted,
      reporter: first,
      tentative: false,
    });
    return (
      <>
        <button
          type="button"
          onClick={() => {
            const acceptedSnapshot = {
              snapshot: stopped,
              acceptedAtWallMs: Date.now(),
            };
            setCurrent((previous) => ({ ...previous, acceptedSnapshot }));
          }}
        >
          Stop
        </button>
        <button
          type="button"
          onClick={() =>
            startTransition(() =>
              setCurrent((previous) => ({
                ...previous,
                reporter: second,
                tentative: true,
              })),
            )
          }
        >
          Attempt reporter
        </button>
        <button
          type="button"
          onClick={() =>
            setCurrent({
              acceptedSnapshot: {
                acceptedAtWallMs: Date.now(),
                snapshot: {
                  ...stopped,
                  takes: [
                    {
                      take_index: 0,
                      session_start_wall_ms: 0,
                      session_start_iso: "",
                      pauses: [],
                      consented_participant_ids: ["p_g"],
                      segment_reports: {},
                    },
                  ],
                },
              },
              reporter: second,
              tentative: false,
            })
          }
        >
          Replay report
        </button>
        <Suspense fallback={<p>Loading reporter</p>}>
          <Probe {...current} />
        </Suspense>
      </>
    );
  }
  render(<Host />);
  await waitFor(() => expect(openKeeperTap).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(
      applied.mock.calls.some(([gate]) => gate.roomState === "stopped"),
    ).toBe(true),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Attempt reporter" }));
  });
  expect(consumedGate).toHaveBeenCalled();
  expect(screen.queryByText("Loading reporter")).not.toBeInTheDocument();
  expect(screen.getByText("Committed reporter")).toBeInTheDocument();
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  await act(async () => stop.resolve());
  expect({ first: first.mock.calls, second: second.mock.calls }).toEqual({
    first: [[0, 0]],
    second: [],
  });
  await act(async () => {
    ready = true;
    pending.resolve();
  });
  fireEvent.click(screen.getByRole("button", { name: "Replay report" }));
  await waitFor(() => expect(second).toHaveBeenCalledWith(0, 0));
  expect(first).toHaveBeenCalledTimes(1);
});

it("keeps committed gate facts while initialization waits through an attempted replacement", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
  const scanEntered = deferred();
  const scanRelease = deferred();
  class HeldSink extends MemorySink {
    override async nextSegmentIndex(
      sessionId: string,
      takeIndex: number,
      participantId: string,
    ) {
      scanEntered.resolve();
      await scanRelease.promise;
      return super.nextSegmentIndex(sessionId, takeIndex, participantId);
    }
  }
  const sink = new HeldSink();
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  const snapshot = recordSnapshot({
    session_id: "gate-room",
    recording_ms: 1000,
    take_index: 0,
  });
  const initial = {
    acceptedSnapshot: { snapshot, acceptedAtWallMs: Date.now() },
    tentative: false,
  };
  const pending = deferred();
  const consumed = vi.spyOn(pending.promise, "then");
  const apply = vi.spyOn(KeeperSession.prototype, "apply");
  function Probe({
    acceptedSnapshot,
    tentative,
  }: {
    acceptedSnapshot: AcceptedRecordSnapshot;
    tentative: boolean;
  }) {
    const keeper = useKeeperCapture({
      enabled: true,
      role: tentative ? "host" : "guest",
      acceptedSnapshot,
      participantId: tentative ? "p_host" : "p_g",
      muted: tentative,
      consented: !tentative,
      stream: tentative ? null : stream,
      sink,
    });
    if (tentative) throw pending.promise;
    return (
      <p>
        {keeper.recordingLocally
          ? "Writing committed gate"
          : "Waiting committed gate"}
      </p>
    );
  }
  function Host() {
    const [current, setCurrent] = useState(initial);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            const next = {
              acceptedSnapshot: {
                snapshot: { ...snapshot, take_index: 3, recording_ms: 9000 },
                acceptedAtWallMs: Date.now(),
              },
              tentative: true,
            };
            startTransition(() => setCurrent(next));
          }}
        >
          Attempt gate
        </button>
        <Suspense fallback={<p>Loading gate</p>}>
          <Probe {...current} />
        </Suspense>
      </>
    );
  }
  const view = render(<Host />);
  await scanEntered.promise;
  expect(apply).not.toHaveBeenCalled();
  vi.setSystemTime(1500);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Attempt gate" }));
  });
  expect(consumed).toHaveBeenCalled();
  expect(screen.getByText("Waiting committed gate")).toBeInTheDocument();
  expect(screen.queryByText("Loading gate")).not.toBeInTheDocument();
  vi.setSystemTime(3500);
  await act(async () => scanRelease.resolve());
  await waitFor(() => expect(apply).toHaveBeenCalled());
  expect(apply.mock.calls[0][0]).toMatchObject({
    role: "guest",
    consented: true,
    muted: false,
    streamAvailable: true,
    sessionId: "gate-room",
    participantId: "p_g",
    takeIndex: 0,
    recordingMs: 4500,
  });
  await screen.findByText("Writing committed gate");
  await act(async () => graph.emit(new Float32Array(480).fill(0.1)));
  const path = keeperWavPath({
    sessionId: "gate-room",
    participantId: "p_g",
    takeIndex: 0,
    segmentIndex: 0,
  });
  await waitFor(() =>
    expect((sink.files.get(path)?.length ?? 0) > 44).toBe(true),
  );
  view.unmount();
  await waitFor(async () =>
    expect(
      parseKeeperMeta(await sink.read(keeperMetaPath(path)))?.complete,
    ).toBe(true),
  );
  expect(parseKeeperMeta(await sink.read(keeperMetaPath(path)))).toMatchObject({
    complete: true,
    joinOffsetMs: 4500,
  });
});
