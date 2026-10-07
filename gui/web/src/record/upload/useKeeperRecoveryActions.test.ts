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
    recoverAllowed?: boolean;
    uploadAvailable?: boolean;
    onRecovered?: () => void;
  } = {},
) {
  return renderHook(
    ({ recoverAllowed, uploadAvailable }) =>
      useKeeperRecoveryActions({
        sink,
        sessionId: ids.sessionId,
        participantId: ids.participantId,
        takeIndex: ids.takeIndex,
        recoverAllowed,
        uploadAvailable,
        onRecovered: overrides.onRecovered ?? (() => undefined),
      }),
    {
      initialProps: {
        recoverAllowed: overrides.recoverAllowed ?? true,
        uploadAvailable: overrides.uploadAvailable ?? true,
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
    rerender({ recoverAllowed: true, uploadAvailable: false });
    await act(async () => release());
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.notice).toBe(
      "Recovered 1 partial segment. Download your full-quality recording to keep a copy.",
    );
  });
});
