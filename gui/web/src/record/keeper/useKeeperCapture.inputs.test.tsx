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
import type { RecordSnapshot } from "../types";
import { openKeeperTap } from "./graph";
import { KeeperSession } from "./session";
import {
  keeperMetaPath,
  keeperWavPath,
  MemorySink,
  parseKeeperMeta,
} from "./store";
import { useKeeperCapture } from "./useKeeperCapture";

vi.mock("./graph", () => ({
  openKeeperTap: vi.fn(async () => ({
    stop: vi.fn(),
    resume: async () => "running" as const,
  })),
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
  function Probe({ current }: { current: RecordSnapshot | null }) {
    const capture = useKeeperCapture({
      enabled: true,
      role: "guest",
      snapshot: current,
      participantId: "p_g",
      muted: false,
      consented: true,
      stream,
      sink,
    });
    if (current && !ready) throw pending.promise;
    return (
      <p>{capture.recordingLocally ? "Recording locally" : "Idle keeper"}</p>
    );
  }
  function Host() {
    const [current, setCurrent] = useState<RecordSnapshot | null>(null);
    return (
      <>
        <button
          type="button"
          onClick={() => startTransition(() => setCurrent(snapshot))}
        >
          Observe snapshot
        </button>
        <Suspense fallback={<p>Loading keeper</p>}>
          <Probe current={current} />
        </Suspense>
      </>
    );
  }
  render(<Host />);
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
  const meta = parseKeeperMeta(await sink.read(keeperMetaPath(path)));
  expect(meta?.joinOffsetMs).toBe(4300);
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
  const stop = deferred();
  const pending = deferred();
  const consumedGate = vi.spyOn(pending.promise, "then");
  heldOperation.stop = stop.promise;
  const applied = vi.spyOn(KeeperSession.prototype, "apply");
  let ready = false;
  function Probe({
    snapshot,
    reporter,
    tentative,
  }: {
    snapshot: RecordSnapshot;
    reporter: (takeIndex: number, segments: number) => void;
    tentative: boolean;
  }) {
    useKeeperCapture({
      enabled: true,
      role: "guest",
      snapshot,
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
      snapshot: paused,
      reporter: first,
      tentative: false,
    });
    return (
      <>
        <button
          type="button"
          onClick={() =>
            setCurrent((previous) => ({ ...previous, snapshot: stopped }))
          }
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
