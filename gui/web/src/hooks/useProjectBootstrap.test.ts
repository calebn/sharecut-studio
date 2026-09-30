import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDocumentState } from "../api/project";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  documentScope,
  isCurrentDocumentScope,
  resetDocumentAuthority,
} from "../document/authorityState";
import type { DocumentSnapshot } from "../document/projectPatch";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { useProjectBootstrap } from "./useProjectBootstrap";

vi.mock("../api/project", () => ({ loadDocumentState: vi.fn() }));
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
  it("keeps a live socket scope valid when a failed bootstrap is retried", async () => {
    const project = minimalProject();
    vi.mocked(loadDocumentState).mockRejectedValueOnce(
      new Error("temporary failure"),
    );
    const hook = renderHook(() => useProjectBootstrap("/tmp/p.json"));
    const socketScope = documentScope();
    await waitFor(() =>
      expect(hook.result.current.error).toBe("temporary failure"),
    );
    vi.mocked(loadDocumentState).mockResolvedValue({
      server_seq: 1,
      state_token: token,
      project,
    });
    act(() => hook.result.current.retry());
    await waitFor(() => expect(useDawStore.getState().project).not.toBeNull());
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
});
