import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedPendingKeeper } from "../../test/keepers";
import { MemorySink } from "../keeper/store";
import * as recovery from "./recovery";
import {
  recoveryNotice,
  useKeeperRecoveryActions,
} from "./useKeeperRecoveryActions";

afterEach(() => vi.restoreAllMocks());

const ids = { sessionId: "room1", takeIndex: 0, participantId: "p_g" };

function renderActions(
  sink: MemorySink | null,
  overrides: {
    takeIndex?: number;
    recoverAllowed?: boolean;
    uploadAvailable?: boolean;
    onRecovered?: () => void;
  } = {},
) {
  return renderHook(
    ({ recoverAllowed, uploadAvailable, takeIndex }) =>
      useKeeperRecoveryActions({
        sink,
        sessionId: ids.sessionId,
        participantId: ids.participantId,
        takeIndex,
        recoverAllowed,
        uploadAvailable,
        onRecovered: overrides.onRecovered ?? (() => undefined),
      }),
    {
      initialProps: {
        recoverAllowed: overrides.recoverAllowed ?? true,
        uploadAvailable: overrides.uploadAvailable ?? true,
        takeIndex: overrides.takeIndex ?? ids.takeIndex,
      },
    },
  );
}

describe("recoveryNotice", () => {
  it("describes what was recovered", () => {
    expect(recoveryNotice({ recovered: 0, trimmed: 0 })).toMatch(
      /No partial recording/,
    );
    expect(recoveryNotice({ recovered: 1, trimmed: 0 })).toBe(
      "Recovered 1 partial segment. Saving to the project will resume.",
    );
    expect(recoveryNotice({ recovered: 2, trimmed: 1 })).toMatch(
      /2 partial segments.*trailing sample was dropped/,
    );
  });
});

describe("recoveryNotice with ended upload access", () => {
  it("keeps the zero-recovered notice independent of upload access", () => {
    expect(recoveryNotice({ recovered: 0, trimmed: 0 }, false)).toBe(
      "No partial recording needed recovery.",
    );
  });

  it("gives download advice and preserves trimmed-sample feedback", () => {
    expect(recoveryNotice({ recovered: 1, trimmed: 1 }, false)).toBe(
      "Recovered 1 partial segment. Download your full-quality recording to keep a copy. An incomplete trailing sample was dropped from the end.",
    );
  });
});

describe("useKeeperRecoveryActions", () => {
  it("exposes no actions until the sink and session are known", () => {
    const { result } = renderActions(null);
    expect(result.current.download).toBeUndefined();
    expect(result.current.recover).toBeUndefined();
  });

  it("recovers once, announces the result, and re-polls upload", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    const onRecovered = vi.fn();
    const run = vi.spyOn(recovery, "recoverLocalKeepers");
    const { result } = renderActions(sink, { onRecovered });
    act(() => {
      result.current.recover?.();
      // A second click during the run is ignored.
      result.current.recover?.();
    });
    expect(result.current.busy).toBe(true);
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(run).toHaveBeenCalledOnce();
    expect(result.current.notice).toBe(
      "Recovered 1 partial segment. Saving to the project will resume.",
    );
    expect(result.current.error).toBeNull();
    expect(onRecovered).toHaveBeenCalledOnce();
  });

  it("does nothing while the room is not stopped and settled", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    const run = vi.spyOn(recovery, "recoverLocalKeepers");
    const { result } = renderActions(sink, { recoverAllowed: false });
    act(() => result.current.recover?.());
    expect(run).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("reports failures in its own error channel and clears them on retry", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    const onRecovered = vi.fn();
    sink.rewriteHeader = async () => {
      throw new Error("locked");
    };
    const { result } = renderActions(sink, { onRecovered });
    act(() => result.current.recover?.());
    await waitFor(() => expect(result.current.error).toMatch(/locked/));
    // Re-poll anyway: a partial run may have recovered other segments.
    expect(onRecovered).toHaveBeenCalledOnce();
    act(() => result.current.download?.());
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("surfaces download failures without a success notice", async () => {
    const { result } = renderActions(new MemorySink());
    act(() => result.current.download?.());
    await waitFor(() =>
      expect(result.current.error).toMatch(
        /No full-quality recording is available/,
      ),
    );
    expect(result.current.notice).toBeNull();
  });

  it("ignores a result that arrives after unmount", async () => {
    const sink = new MemorySink();
    let finish: (value: recovery.KeeperRecoveryResult) => void = () =>
      undefined;
    vi.spyOn(recovery, "recoverLocalKeepers").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onRecovered = vi.fn();
    const { result, unmount } = renderActions(sink, { onRecovered });
    act(() => result.current.recover?.());
    unmount();
    await act(async () => finish({ recovered: 1, trimmed: 0 }));
    expect(onRecovered).not.toHaveBeenCalled();
  });
  it("recovers local audio without promising an unavailable upload", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    const { result } = renderActions(sink, { uploadAvailable: false });
    act(() => result.current.recover?.());
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.notice).toBe(
      "Recovered 1 partial segment. Download your full-quality recording to keep a copy.",
    );
    expect(result.current.error).toBeNull();
  });

  it("uses ended upload access when it changes during recovery", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    const rewriteHeader = sink.rewriteHeader.bind(sink);
    let release: () => void = () => undefined;
    const pendingWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writing = false;
    sink.rewriteHeader = async (path, header, byteLength) => {
      writing = true;
      await pendingWrite;
      await rewriteHeader(path, header, byteLength);
    };
    const { result, rerender } = renderActions(sink);
    act(() => result.current.recover?.());
    await waitFor(() => expect(writing).toBe(true));
    rerender({
      recoverAllowed: true,
      uploadAvailable: false,
      takeIndex: ids.takeIndex,
    });
    await act(async () => release());
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.notice).toBe(
      "Recovered 1 partial segment. Download your full-quality recording to keep a copy.",
    );
  });

  it("names the action in flight, and nothing once idle", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    const { result } = renderActions(sink);
    expect(result.current.running).toBeNull();
    act(() => result.current.recover?.());
    expect(result.current.running).toBe("recover");
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.running).toBeNull();
    let finish: () => void = () => undefined;
    vi.spyOn(recovery, "downloadLocalKeepers").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    act(() => result.current.download?.());
    expect(result.current.running).toBe("download");
    await act(async () => finish());
    await waitFor(() => expect(result.current.running).toBeNull());
  });

  it("a finished download sets downloaded, and the next run clears it", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    vi.spyOn(recovery, "downloadLocalKeepers").mockResolvedValue(undefined);
    const { result } = renderActions(sink);
    expect(result.current.downloaded).toBe(false);
    act(() => result.current.download?.());
    await waitFor(() => expect(result.current.downloaded).toBe(true));
    await waitFor(() => expect(result.current.busy).toBe(false));
    act(() => result.current.recover?.());
    expect(result.current.downloaded).toBe(false);
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("a partial download leaves downloaded false and reports what was lost", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    const loss =
      "Downloaded 2 full-quality recordings; 1 missing segment could not be exported.";
    vi.spyOn(recovery, "downloadLocalKeepers").mockRejectedValue(
      new Error(loss),
    );
    const { result } = renderActions(sink);
    act(() => result.current.download?.());
    await waitFor(() => expect(result.current.error).toBe(loss));
    expect(result.current.downloaded).toBe(false);
  });

  it("stops counting a download once a later take exists", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    vi.spyOn(recovery, "downloadLocalKeepers").mockResolvedValue(undefined);
    const { result, rerender } = renderActions(sink);
    act(() => result.current.download?.());
    await waitFor(() => expect(result.current.downloaded).toBe(true));
    rerender({
      recoverAllowed: true,
      uploadAvailable: true,
      takeIndex: ids.takeIndex + 1,
    });
    expect(result.current.downloaded).toBe(false);
  });

  it("keeps downloaded while a second download runs and drops it only if that run fails", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    const run = vi
      .spyOn(recovery, "downloadLocalKeepers")
      .mockResolvedValueOnce(undefined);
    const { result } = renderActions(sink);
    act(() => result.current.download?.());
    await waitFor(() => expect(result.current.downloaded).toBe(true));
    await waitFor(() => expect(result.current.busy).toBe(false));

    let fail: (reason: Error) => void = () => undefined;
    run.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    act(() => result.current.download?.());
    expect(result.current.busy).toBe(true);
    expect(result.current.downloaded).toBe(true);
    await act(async () => fail(new Error("Disk full.")));
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.downloaded).toBe(false);
    expect(result.current.error).toBe("Disk full.");
  });
});
