import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import type { HostRoom } from "../../record";
import { HostRoomProvider } from "../../record/hostRoomContext";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import { stubMatchMedia } from "../../test/matchMedia";
import { StageFrame } from "./StageFrame";

const meter = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("../../record/sharedMeterContext", () => ({
  acquireMeterContext: meter.acquire,
}));
vi.mock("../../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/offlineQueue/offlineStore")
  >()),
  loadGuestAttention: vi.fn(async () => ({ pending: 0, conflicts: [] })),
}));

const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });

describe("StageFrame muted-speech tap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    stubMatchMedia(false);
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/frame/e.sharecut", minimalProject());
    useDawStore.setState({ stage: "edit", guestMode: null });
    meter.acquire.mockImplementation(() => ({
      ctx: {
        state: "running",
        resume: vi.fn(() => Promise.resolve()),
        createMediaStreamSource: node,
        createAnalyser: () => ({
          ...node(),
          fftSize: 0,
          getFloatTimeDomainData: vi.fn(),
        }),
        createGain: () => ({ ...node(), gain: { value: 1 } }),
        destination: {},
      },
      ready: Promise.resolve(),
      release: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    meter.acquire.mockReset();
  });

  it("clones a muted away host mic once", async () => {
    const clone = vi.fn(() => {
      const track = { enabled: false, stop: vi.fn() };
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    });
    const room = {
      snapshot: {
        session_id: "s1",
        state: "recording",
        take_index: 0,
        participants: [],
      },
      state: "recording",
      capture: { stream: { clone } },
      upload: { error: null, recoverable: false },
      hostSegments: [],
      host: { muted: true },
      micLive: true,
    } as unknown as HostRoom;
    render(
      <HostRoomProvider value={room}>
        <StageFrame>{() => <p>stage body</p>}</StageFrame>
      </HostRoomProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(clone).toHaveBeenCalledTimes(1);
    expect(meter.acquire).toHaveBeenCalledTimes(1);
  });
});
