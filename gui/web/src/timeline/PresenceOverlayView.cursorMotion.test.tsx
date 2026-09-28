import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { SessionClient } from "../types/session";
import { PresenceOverlayView } from "./PresenceOverlayView";

const motionLog = vi.hoisted(() => ({ created: 0, dropped: [] as string[] }));

vi.mock("../presence/cursorMotion", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../presence/cursorMotion")>();
  return {
    ...real,
    createCursorMotion: (
      opts?: Parameters<typeof real.createCursorMotion>[0],
    ) => {
      motionLog.created += 1;
      const inner = real.createCursorMotion(opts);
      return {
        step: inner.step,
        drop: (key: string) => {
          motionLog.dropped.push(key);
          inner.drop(key);
        },
      };
    },
  };
});

const NOW_MS = 1_800_000_000_000;
const tracks = [sampleTrack({ id: "host", label: "Host" })];
const project = minimalProject({ tracks });

function cursorClient(id: string): SessionClient {
  return {
    client_id: id,
    role: "viewer",
    last_seen_ns: NOW_MS * 1e6,
    meta: { display_name: id, cursor: { t_sec: 1, track_id: "host" } },
  };
}

function view(clients: SessionClient[]) {
  return (
    <PresenceOverlayView
      clients={clients}
      localClientId="me"
      nowMs={NOW_MS}
      project={project}
      zoomPxPerSec={10}
      height={72}
      laneHeight={72}
      tracks={tracks}
      clipsByTrack={{}}
    />
  );
}

beforeEach(() => {
  motionLog.created = 0;
  motionLog.dropped = [];
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

it("forgets a departed client's cursor motion and builds the motion once", () => {
  const { rerender, unmount } = render(
    view([cursorClient("ada"), cursorClient("bea")]),
  );
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  rerender(view([cursorClient("ada")]));
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(motionLog.dropped).toEqual(["bea"]);
  rerender(view([]));
  expect(motionLog.dropped).toEqual(["bea", "ada"]);
  expect(motionLog.created).toBe(1);
  unmount();
});
