import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ByteSink,
  keeperMetaPath,
  keeperWavPath,
  MemorySink,
} from "../keeper/store";
import { downloadLocalKeeper, downloadLocalKeepers } from "./recovery";

beforeEach(() => vi.stubGlobal("Blob", NodeBlob));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("downloadLocalKeepers", () => {
  it.each(["p_host", "p_guest"])(
    "exports every retained take and segment for %s, labeling partials, without deleting OPFS",
    async (participantId) => {
      vi.useFakeTimers();
      const urls: string[] = [];
      const blobs: Blob[] = [];
      const revokeObjectURL = vi.fn();
      const NativeURL = URL;
      class DownloadURL extends NativeURL {
        static createObjectURL(blob: Blob) {
          const url = `blob:keeper-${urls.length}`;
          urls.push(url);
          blobs.push(blob);
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
        const wavPath = keeperWavPath({
          sessionId: "room1",
          participantId,
          takeIndex,
          segmentIndex,
        });
        await sink.write(wavPath, new Uint8Array([1, 2, 3]));
        // Segment 0-1 stopped mid-write, so it has no completion metadata.
        if (!(takeIndex === 0 && segmentIndex === 1)) {
          await sink.write(keeperMetaPath(wavPath), new Uint8Array([123]));
        }
      }
      const remove = vi.spyOn(sink, "remove");
      await downloadLocalKeepers(sink, "room1", participantId, 1);
      expect(filenames).toEqual([`keepers-${participantId}.zip`]);
      expect(blobs[0]?.type).toBe("application/zip");
      const archive = new TextDecoder("latin1").decode(
        await blobs[0]!.arrayBuffer(),
      );
      for (const name of [
        "keeper-0-0.wav",
        "keeper-0-1-partial.wav",
        "keeper-1-0.wav",
      ]) {
        expect(archive).toContain(name);
      }
      expect(archive).not.toContain("keeper-0-1.wav");
      expect(remove).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a missing local copy rather than silently succeeding", async () => {
    await expect(
      downloadLocalKeepers(new MemorySink(), "room1", "p_guest", 0),
    ).rejects.toThrow("No local keeper copy");
  });

  it("exports surviving sparse segments before reporting missing copies", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:keeper"),
      revokeObjectURL: vi.fn(),
    });
    const filenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filenames.push(this.download);
    });
    const sink = new MemorySink();
    for (const [takeIndex, segmentIndex] of [
      [0, 0],
      [0, 2],
      [1, 0],
    ]) {
      await sink.write(
        keeperWavPath({
          sessionId: "room1",
          participantId: "p_guest",
          takeIndex,
          segmentIndex,
        }),
        new Uint8Array([1, 2, 3]),
      );
    }
    await expect(
      downloadLocalKeepers(sink, "room1", "p_guest", 1),
    ).rejects.toThrow("Downloaded 3 local keeper copies; 1 missing segment");
    expect(filenames).toEqual(["keepers-p_guest.zip"]);
    await vi.runAllTimersAsync();
  });

  it("downloads a native OPFS File without reading its bytes", async () => {
    vi.useFakeTimers();
    const file = new File(["wav"], "keeper.wav", { type: "audio/wav" });
    const createObjectURL = vi.fn(() => "blob:keeper");
    vi.stubGlobal("URL", {
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    const read = vi.fn(async () => {
      throw new Error("bytes should not be read");
    });
    const sink = {
      read,
      readBlob: async () => file,
    } as unknown as ByteSink;
    expect(await downloadLocalKeeper(sink, "keeper.wav", "keeper.wav")).toBe(
      true,
    );
    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(read).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
  });
});
