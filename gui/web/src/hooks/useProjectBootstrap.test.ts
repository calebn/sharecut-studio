import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDocumentState } from "../api/project";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  documentScope,
  isCurrentDocumentScope,
  resetDocumentAuthority,
} from "../document/authorityState";
import type { DocumentSnapshot } from "../document/projectPatch";
import { waitsForConnection } from "../shellLoadFailure";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { ApiError } from "../utils/apiError";
import { useBackOnline } from "./useBackOnline";
import { useProjectBootstrap } from "./useProjectBootstrap";

vi.mock("../api/project", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/project")>()),
  loadDocumentState: vi.fn(),
}));
vi.mock("../document/applyDocumentUpdate", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../document/applyDocumentUpdate")>();
  return {
    ...real,
    applyDocumentSnapshot: vi.fn(real.applyDocumentSnapshot),
  };
});
const token = "a".repeat(64);
const shell = () =>
  minimalProject({
    project_path: "/tmp/p.json",
    tracks: [sampleTrack()],
    meta: {
      name: "Shell",
      workspace_dir: "/tmp",
      hydration: { transcript_words: false, history_groups: false },
    },
  });
function detail(seq = 0): DocumentSnapshot {
  return {
    server_seq: seq,
    state_token: token,
    patch: {
      transcript: { utterances: [] },
      meta: {
        name: "Hydrated",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
    },
  };
}
beforeEach(() => {
  vi.mocked(loadDocumentState).mockReset();
  resetDocumentAuthority();
  useDawStore.getState().hydrate("/tmp/p.json", null);
});
describe("sequenced project bootstrap", () => {
  it("installs the actual shell sequence then hydrates detail without resetting waveform state", async () => {
    const project = shell();
    vi.mocked(loadDocumentState)
      .mockResolvedValueOnce({ server_seq: 0, state_token: token, project })
      .mockResolvedValueOnce(detail());
    const hydrate = vi.spyOn(useDawStore.getState(), "hydrate");
    renderHook(() => useProjectBootstrap("/tmp/p.json"));
    await waitFor(() =>
      expect(
        useDawStore.getState().project?.meta.hydration?.transcript_words,
      ).toBe(true),
    );
    expect(useDawStore.getState().project?.tracks).toBe(project.tracks);
    expect(loadDocumentState).toHaveBeenNthCalledWith(
      1,
      "/tmp/p.json",
      "shell",
      expect.any(AbortSignal),
    );
    expect(loadDocumentState).toHaveBeenNthCalledWith(
      2,
      "/tmp/p.json",
      "detail",
      expect.any(AbortSignal),
    );
    expect(hydrate).not.toHaveBeenCalled();
  });
  it("aborts on unmount and rejects a late shell", async () => {
    let resolve!: (value: DocumentSnapshot) => void;
    vi.mocked(loadDocumentState).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { unmount } = renderHook(() => useProjectBootstrap("/tmp/p.json"));
    const signal = vi.mocked(loadDocumentState).mock.calls[0][2]!;
    unmount();
    resolve({ server_seq: 0, state_token: token, project: shell() });
    await act(async () => {
      await Promise.resolve();
    });
    expect(signal.aborted).toBe(true);
    expect(useDawStore.getState().project).toBeNull();
  });
  it("discards racing old detail and hydrates the new sequence", async () => {
    let resolve!: (value: DocumentSnapshot) => void;
    vi.mocked(loadDocumentState)
      .mockResolvedValueOnce({
        server_seq: 0,
        state_token: token,
        project: shell(),
      })
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce(detail(7));
    renderHook(() => useProjectBootstrap("/tmp/p.json"));
    await waitFor(() => expect(loadDocumentState).toHaveBeenCalledTimes(2));
    await act(async () => {
      applyDocumentSnapshot({
        server_seq: 7,
        state_token: token,
        project: shell(),
      });
      resolve({
        ...detail(),
        patch: {
          ...detail().patch,
          meta: { name: "Stale", workspace_dir: "/tmp" },
        },
      });
    });
    await waitFor(() =>
      expect(useDawStore.getState().project?.meta.name).toBe("Hydrated"),
    );
    expect(loadDocumentState).toHaveBeenCalledTimes(3);
  });
  it("does not warm-retry when the episode was empty at bootstrap start", async () => {
    let shellLoads = 0;
    vi.mocked(loadDocumentState).mockImplementation(async () => {
      shellLoads += 1;
      throw new DOMException("The server didn't answer.", "TimeoutError");
    });
    const hook = renderHook(() => useProjectBootstrap("/tmp/p.json"));
    await waitFor(() => expect(hook.result.current.failure).not.toBeNull());
    expect(hook.result.current.failure).toEqual({
      audience: "host",
      kind: "not-answering",
    });
    expect(shellLoads).toBe(1);
    expect(hook.result.current.retrying).toBe(false);
  });

  it("retries a warm shell load when the server is slow but the episode is open", async () => {
    const project = shell();
    useDawStore.getState().hydrate("/tmp/p.json", project);
    let shellLoads = 0;
    vi.mocked(loadDocumentState).mockImplementation(async (_path, phase) => {
      if (phase === "shell") {
        shellLoads += 1;
        if (shellLoads === 1) {
          throw new DOMException("The server didn't answer.", "TimeoutError");
        }
        return { server_seq: 0, state_token: token, project };
      }
      return detail();
    });
    const hook = renderHook(() => useProjectBootstrap("/tmp/p.json"));
    await waitFor(() => expect(shellLoads).toBe(2), { timeout: 5_000 });
    expect(hook.result.current.failure).toBeNull();
  });

  it("keeps a live socket scope valid when a failed bootstrap is retried", async () => {
    const project = minimalProject();
    vi.mocked(loadDocumentState).mockRejectedValueOnce(
      new Error("temporary failure"),
    );
    const hook = renderHook(() => useProjectBootstrap("/tmp/p.json"));
    const socketScope = documentScope();
    await waitFor(() =>
      expect(hook.result.current.failure).toEqual({
        audience: "host",
        kind: "other",
      }),
    );
    expect(JSON.stringify(hook.result.current)).not.toContain(
      "temporary failure",
    );
    vi.mocked(loadDocumentState).mockResolvedValue({
      server_seq: 1,
      state_token: token,
      project,
    });
    act(() => hook.result.current.retry());
    expect(hook.result.current.retrying).toBe(true);
    await waitFor(() => expect(useDawStore.getState().project).not.toBeNull());
    await waitFor(() => expect(hook.result.current.retrying).toBe(false));
    expect(isCurrentDocumentScope(socketScope)).toBe(true);
    applyDocumentSnapshot(
      {
        server_seq: 2,
        state_token: token,
        project: minimalProject({
          meta: { name: "Peer after retry", workspace_dir: "/tmp" },
        }),
      },
      { scope: socketScope },
    );
    expect(useDawStore.getState().project?.meta.name).toBe("Peer after retry");
  });
  it("clears a retired failure when disabled and starts a fresh same-path attempt", async () => {
    vi.mocked(loadDocumentState).mockRejectedValueOnce(
      new Error("old failure"),
    );
    const hook = renderHook(
      ({ enabled }) => useProjectBootstrap("/tmp/p.json", enabled),
      {
        initialProps: { enabled: true },
      },
    );
    await waitFor(() => expect(hook.result.current.failure).not.toBeNull());
    hook.rerender({ enabled: false });
    expect(hook.result.current.failure).toBeNull();
    expect(hook.result.current.retrying).toBe(false);
    vi.mocked(loadDocumentState).mockResolvedValue({
      server_seq: 0,
      state_token: token,
      project: minimalProject(),
    });
    hook.rerender({ enabled: true });
    await waitFor(() => expect(useDawStore.getState().project).not.toBeNull());
    expect(hook.result.current.failure).toBeNull();
  });

  it("rejects a late shell from the first visit after returning to the same path", async () => {
    let finishOld!: (value: DocumentSnapshot) => void;
    let finishFresh!: (value: DocumentSnapshot) => void;
    vi.mocked(loadDocumentState)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFresh = resolve;
          }),
      );
    const hook = renderHook(
      ({ enabled }) => useProjectBootstrap("/tmp/p.json", enabled),
      {
        initialProps: { enabled: true },
      },
    );
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    await act(async () => {
      finishOld({ server_seq: 0, state_token: token, project: shell() });
    });
    expect(useDawStore.getState().project).toBeNull();
    await act(async () => {
      finishFresh({
        server_seq: 1,
        state_token: token,
        project: minimalProject(),
      });
    });
    expect(useDawStore.getState().project).not.toBeNull();
    expect(loadDocumentState).toHaveBeenCalledTimes(2);
  });

  it("keeps the failure on screen through a retry, and clears it when the load works", async () => {
    vi.mocked(loadDocumentState).mockRejectedValueOnce(new Error("x"));
    const hook = renderHook(() => useProjectBootstrap("/tmp/p.json"));
    await waitFor(() => expect(hook.result.current.failure).not.toBeNull());
    const failed = hook.result.current.failure;
    let finish!: (value: DocumentSnapshot) => void;
    vi.mocked(loadDocumentState).mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    act(() => hook.result.current.retry());
    expect(hook.result.current).toMatchObject({
      failure: failed,
      retrying: true,
      attempt: 1,
    });
    await act(async () => {
      finish({ server_seq: 0, state_token: token, project: minimalProject() });
    });
    await waitFor(() => expect(hook.result.current.failure).toBeNull());
    expect(hook.result.current.retrying).toBe(false);
  });

  it("shows no failure for a retry pressed while nothing has failed", async () => {
    vi.mocked(loadDocumentState).mockImplementation(
      () => new Promise(() => {}),
    );
    const hook = renderHook(() => useProjectBootstrap("/tmp/p.json"));
    act(() => hook.result.current.retry());
    expect(hook.result.current).toMatchObject({
      failure: null,
      retrying: false,
      attempt: 1,
    });
  });

  it("keeps nothing the server said, in the failure or anywhere the hook returns", async () => {
    vi.mocked(loadDocumentState).mockRejectedValue(
      new ApiError("ZEBRA-secret-9931", "x", 500, null, {
        detail: "ZEBRA-secret-9931",
      }),
    );
    const hook = renderHook(() => useProjectBootstrap("/tmp/p.json"));
    await waitFor(() => expect(hook.result.current.failure).not.toBeNull());
    expect(JSON.stringify(hook.result.current)).not.toContain("ZEBRA");
    expect(
      Object.values(hook.result.current).filter((v) => typeof v === "string"),
    ).toEqual([]);
  });

  it.each([
    ["host", "/tmp/p.json", { audience: "host", kind: "other" }],
    ["guest", "share:abc", { audience: "guest", failure: { kind: "server" } }],
  ])(
    "reads an answer the page cannot apply as the host answering for a %s, never as no answer",
    async (_who, key, expected) => {
      vi.mocked(loadDocumentState).mockResolvedValue({
        server_seq: 0,
        state_token: token,
        project: minimalProject(),
      });
      vi.mocked(applyDocumentSnapshot).mockImplementationOnce(() => {
        throw new TypeError("x is undefined");
      });
      const hook = renderHook(() => useProjectBootstrap(key));
      await waitFor(() =>
        expect(hook.result.current.failure).toEqual(expected),
      );
    },
  );

  describe("a guest's failure that promises a retry", () => {
    const GUEST = "share:abc";
    const calls = () => vi.mocked(loadDocumentState).mock.calls.length;
    const down = () => new ApiError("x", "network_error", null);
    const ok = {
      server_seq: 0,
      state_token: token,
      project: minimalProject(),
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function failedGuest(error: unknown) {
      vi.mocked(loadDocumentState).mockRejectedValueOnce(error);
      const hook = renderHook(() => useProjectBootstrap(GUEST));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(hook.result.current.failure).not.toBeNull();
      return hook;
    }

    it("tries again by itself after 30 seconds, shows it as in flight, and clears on success", async () => {
      const hook = await failedGuest(down());
      expect(calls()).toBe(1);
      vi.mocked(loadDocumentState).mockResolvedValue(ok);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_999);
      });
      expect(calls()).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(calls()).toBe(2);
      expect(hook.result.current.failure).toBeNull();
    });

    it("keeps trying every 30 seconds while it keeps failing", async () => {
      const hook = await failedGuest(down());
      vi.mocked(loadDocumentState).mockRejectedValue(down());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(calls()).toBe(3);
      expect(hook.result.current.failure).not.toBeNull();
    });

    it("waits as long as a 429 asked, between 5 and 120 seconds", async () => {
      await failedGuest(new ApiError("x", "rate_limited", 429, null, null, 60));
      vi.mocked(loadDocumentState).mockResolvedValue(ok);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_999);
      });
      expect(calls()).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(calls()).toBe(2);
    });

    it("tries at once when the page's own Try now is pressed, and does not also fire the old timer", async () => {
      const hook = await failedGuest(down());
      vi.mocked(loadDocumentState).mockRejectedValue(new Error("x"));
      act(() => hook.result.current.retry());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls()).toBe(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(calls()).toBe(2);
    });

    it("tries again by itself after 30 seconds when the host answered busy", async () => {
      await failedGuest(new ApiError("x", "project_busy", 503));
      vi.mocked(loadDocumentState).mockResolvedValue(ok);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_999);
      });
      expect(calls()).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(calls()).toBe(2);
    });

    it("makes one attempt, not two, when the connection returns while an attempt is out", async () => {
      const onLine = vi
        .spyOn(navigator, "onLine", "get")
        .mockReturnValue(false);
      vi.mocked(loadDocumentState).mockRejectedValueOnce(down());
      const hook = renderHook(() => {
        const read = useProjectBootstrap(GUEST);
        useBackOnline(
          waitsForConnection(read.failure, read.retrying),
          read.attempt,
          read.retry,
        );
        return read;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(hook.result.current.failure).toMatchObject({
        failure: { kind: "offline" },
      });

      vi.mocked(loadDocumentState).mockReturnValue(new Promise(() => {}));
      act(() => hook.result.current.retry());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls()).toBe(2);
      onLine.mockReturnValue(true);
      act(() => void window.dispatchEvent(new Event("online")));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls()).toBe(2);
      onLine.mockRestore();
    });

    it.each([
      ["a sign-in", new ApiError("x", null, 401)],
      ["a restricted link", new ApiError("x", null, 403)],
      ["a server error", new ApiError("x", null, 500)],
      ["a link that may be gone", new ApiError("x", "share_not_found", 404)],
      [
        "a link that is not available",
        new ApiError("x", "project_not_found", 404),
      ],
      ["a page that was not JSON", new SyntaxError("x")],
    ])("does not try again by itself for %s", async (_name, error) => {
      await failedGuest(error);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000);
      });
      expect(calls()).toBe(1);
    });
  });

  it("never tries again by itself for a host", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(loadDocumentState).mockRejectedValue(
        new ApiError("x", "network_error", null),
      );
      renderHook(() => useProjectBootstrap("/tmp/p.json"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000);
      });
      expect(loadDocumentState).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
