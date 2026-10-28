import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { HostRoom } from "../../record";
import { HostRoomProvider } from "../../record/hostRoomContext";
import { useDawStore } from "../../state/dawStore";
import { useStageBadges } from "./useStageBadges";

const room = (micLossNeedsAttention: boolean) =>
  ({
    micLossNeedsAttention,
    captureUnavailable: false,
    noAudioNeedsAttention: false,
  }) as HostRoom;

const wrap =
  (value: HostRoom) =>
  ({ children }: { children: ReactNode }) => (
    <HostRoomProvider value={value}>{children}</HostRoomProvider>
  );

describe("useStageBadges mic loss", () => {
  beforeEach(() => {
    useDawStore.setState({ stage: "edit", statusAnnouncement: "" });
  });

  it("badges Record and announces once when the mic stops on another stage", () => {
    const { result, rerender } = renderHook(() => useStageBadges(), {
      wrapper: wrap(room(true)),
    });
    expect(result.current.record).toEqual({ kind: "failed" });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Your mic stopped. Open Record to reconnect it.",
    );
    useDawStore.setState({ statusAnnouncement: "" });
    rerender();
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });

  it("stays quiet on the Record stage", () => {
    useDawStore.setState({ stage: "record" });
    const { result } = renderHook(() => useStageBadges(), {
      wrapper: wrap(room(true)),
    });
    expect(result.current.record).toBeUndefined();
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });
});
