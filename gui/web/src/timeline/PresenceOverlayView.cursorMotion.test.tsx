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

it("animates a stamped playhead with no cursor, then holds pause and releases rAF", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  const leader: SessionClient = {
    client_id: "lead",
    role: "viewer",
    last_seen_ns: NOW_MS * 1e6,
    meta: {
      transport: {
        playing: true,
        playhead_sec: 2,
        rate: 1.5,
        stamped_ns: NOW_MS * 1e6,
      },
    },
  };
  const { container, rerender, unmount } = render(view([leader]));
  const ghost = container.querySelector<HTMLElement>(".presence-playhead");
  expect(ghost?.style.left).toBe("20px");
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(Number.parseFloat(ghost?.style.left ?? "0")).toBeCloseTo(35, 0);
  rerender(
    view([
      {
        ...leader,
        meta: {
          transport: {
            playing: false,
            playhead_sec: 4,
            rate: 1.5,
            stamped_ns: (NOW_MS + 1000) * 1e6,
          },
        },
      },
    ]),
  );
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(ghost?.style.left).toBe("40px");
  expect(vi.getTimerCount()).toBe(0);
  unmount();
});
