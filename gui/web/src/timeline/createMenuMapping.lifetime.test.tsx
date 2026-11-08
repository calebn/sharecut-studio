import { render } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { duplicateSegment } from "../api";
import { registerDawCommands } from "../commands/register";
import { setClipboard } from "../edit/clipboard";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { runCreatePick } from "./createMenuMapping";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  duplicateSegment: vi.fn(),
}));

const project = minimalProject({
  tracks: [sampleTrack({ id: "host", label: "Receiving host" })],
});

function lane(key: string) {
  return createElement("div", {
    key,
    className: "lane-row",
    "data-track-id": "host",
    "aria-label": "Receiving host",
    role: "group",
    tabIndex: -1,
  });
}

beforeEach(() => {
  useDawStore.getState().hydrate("/projects/origin.sharecut", project);
  useDawStore.setState({
    guestMode: null,
    shareCapabilities: null,
    stage: "edit",
  });
  registerDawCommands();
  setClipboard({
    mode: "copy",
    timelineStart: 0,
    timelineEnd: 4,
    extracts: [],
  });
});

describe("Create menu paste focus lifetime", () => {
  it.each([
    "switch before reply",
    "switch before frame",
    "same-path refresh",
  ] as const)(
    "focuses a lane only when its project remains current through the frame (%s)",
    async (timing) => {
      const request = deferred<null>();
      const duplicate = vi.mocked(duplicateSegment);
      duplicate.mockReset();
      duplicate.mockReturnValue(request.promise);
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(
        (callback) => {
          frames.push(callback);
          return frames.length;
        },
      );
      const { container, rerender } = render(lane("origin"));
      const originLane = container.firstElementChild;
      const pending = runCreatePick("paste", { trackId: "host", atTime: 20 });
      expect(duplicate).toHaveBeenCalledExactlyOnceWith(
        "/projects/origin.sharecut",
        0,
        4,
        20,
      );

      if (timing === "switch before reply") {
        useDawStore.getState().hydrate("/projects/receiving.sharecut", project);
        rerender(lane("receiving"));
      }
      request.resolve(null);
      await pending;

      if (timing === "switch before frame") {
        useDawStore.getState().hydrate("/projects/receiving.sharecut", project);
        rerender(lane("receiving"));
      } else if (timing === "same-path refresh") {
        const epoch = useDawStore.getState().projectEpoch;
        useDawStore.getState().hydrate("/projects/origin.sharecut", project);
        expect(useDawStore.getState().projectEpoch).toBe(epoch);
      }
      expect(frames).toHaveLength(1);
      frames.forEach((frame) => frame(0));

      expect(document.activeElement).toBe(
        timing === "same-path refresh" ? originLane : document.body,
      );
    },
  );
});
