import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDocumentSeqForTests } from "../document/cursor";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { TrackView } from "../types/project";
import { useDocumentSync } from "./useDocumentSync";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const track = (id: string, label = id): TrackView => ({
  id,
  label,
  role: "dialogue",
  speaker: null,
  gain_db: 0,
  muted: false,
  duration_sec: 1,
  fx_count: 0,
  stem_is_fresh: true,
});

describe("useDocumentSync", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    resetDocumentSeqForTests();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    useDawStore.getState().hydrate("/tmp/ep.json", minimalProject());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges patch.tracks, skips Echo, and keeps comments-only merges", async () => {
    renderHook(() =>
      useDocumentSync("/tmp/ep.json", minimalProject(), () => undefined, true),
    );
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        server_seq: 2,
        snapshot: {
          server_seq: 2,
          patch: { tracks: [track("b"), track("a")] },
        },
      });
    });
    expect(useDawStore.getState().project?.tracks.map((t) => t.id)).toEqual([
      "b",
      "a",
    ]);
    const tracksAfterPatch = useDawStore.getState().project?.tracks;

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Echo",
        server_seq: 2,
        snapshot: { server_seq: 2, project: minimalProject() },
      });
    });
    expect(useDawStore.getState().project?.tracks).toBe(tracksAfterPatch);

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        server_seq: 3,
        snapshot: {
          server_seq: 3,
          comments: [{ id: "c1", body: "note" }],
        },
      });
    });
    expect(useDawStore.getState().project?.comments).toEqual([
      { id: "c1", body: "note" },
    ]);
    expect(useDawStore.getState().project?.tracks).toBe(tracksAfterPatch);
  });

  it("skips Echo first and still applies a later same-seq Applied", async () => {
    renderHook(() =>
      useDocumentSync("/tmp/ep.json", minimalProject(), () => undefined, true),
    );
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Echo",
        server_seq: 4,
        snapshot: {
          server_seq: 4,
          project: minimalProject({ tracks: [track("echo")] }),
        },
      });
    });
    expect(useDawStore.getState().project?.tracks.map((t) => t.id)).not.toEqual(
      ["echo"],
    );

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        server_seq: 4,
        snapshot: {
          server_seq: 4,
          patch: { tracks: [track("real")] },
        },
      });
    });
    expect(useDawStore.getState().project?.tracks.map((t) => t.id)).toEqual([
      "real",
    ]);
  });
});
