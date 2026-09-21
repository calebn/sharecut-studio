import { afterEach, describe, expect, it, vi } from "vitest";
import { keeperWavPath, MemorySink } from "../keeper/store";
import { downloadLocalKeepers } from "./recovery";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("downloadLocalKeepers", () => {
  it.each(["p_host", "p_guest"])(
    "exports every retained take and segment for %s without deleting OPFS",
    async (participantId) => {
      vi.useFakeTimers();
      const urls: string[] = [];
      const revokeObjectURL = vi.fn();
      const NativeURL = URL;
      class DownloadURL extends NativeURL {
        static createObjectURL() {
          const url = `blob:keeper-${urls.length}`;
          urls.push(url);
          return url;
        }
        static revokeObjectURL = revokeObjectURL;
      }
      vi.stubGlobal("URL", DownloadURL);
      const filenames: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
        function (this: HTMLAnchorElement) {
          filenames.push(this.download);
        },
      );
      const sink = new MemorySink();
      const paths = [
        [0, 0],
        [0, 1],
        [1, 0],
      ];
      for (const [takeIndex, segmentIndex] of paths) {
        await sink.write(
          keeperWavPath({
            sessionId: "room1",
            participantId,
            takeIndex,
            segmentIndex,
          }),
          new Uint8Array([1, 2, 3]),
        );
      }
      const remove = vi.spyOn(sink, "remove");
      await downloadLocalKeepers(sink, "room1", participantId, 1);
      expect(filenames).toEqual([
        "keeper-0-0.wav",
        "keeper-0-1.wav",
        "keeper-1-0.wav",
      ]);
      expect(remove).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(revokeObjectURL).toHaveBeenCalledTimes(3);
    },
  );

  it("reports a missing local copy rather than silently succeeding", async () => {
    await expect(
      downloadLocalKeepers(new MemorySink(), "room1", "p_guest", 0),
    ).rejects.toThrow("No local keeper copy");
  });
});
