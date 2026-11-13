import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject } from "../test/fixtures";
import { documentAuthority, resetDocumentAuthority } from "./authorityState";
import { scheduleTranscriptDetailHydrate } from "./hydrateTranscriptDetail";
import type { DocumentSnapshot } from "./projectPatch";
import { useTranscriptDetail } from "./useTranscriptDetail";

const { loadDetail } = vi.hoisted(() => ({ loadDetail: vi.fn() }));
vi.mock("../api/project", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/project")>()),
  loadDocumentState: loadDetail,
}));

afterEach(() => {
  resetDocumentAuthority();
});

it("only lets the current Retry restart a failure after an untracked view", async () => {
  const project = minimalProject({
    meta: {
      name: "Test Episode",
      workspace_dir: "/tmp/test",
      hydration: { transcript_words: false },
    },
  });
  useDawStore
    .getState()
    .hydrate(
      "share:tok",
      project,
      "comment",
      ["view", "comment", "suggest"],
      null,
      true,
    );
  resetDocumentAuthority("share:tok");
  const request = deferred<DocumentSnapshot>();
  const replacement = deferred<DocumentSnapshot>();
  loadDetail
    .mockReturnValueOnce(request.promise)
    .mockReturnValueOnce(replacement.promise);
  const { result } = renderHook(useTranscriptDetail);
  const untracked = result.current;
  expect(untracked.kind).toBe("pending");
  if (untracked.kind !== "pending") throw new Error("Expected untracked Retry");
  expect(loadDetail).toHaveBeenCalledTimes(0);

  act(() => scheduleTranscriptDetailHydrate(project));
  await act(async () => request.reject(new Error("private transport detail")));
  const failed = result.current;
  expect(failed).toMatchObject({ kind: "failed", recovering: false });
  if (failed.kind !== "failed") throw new Error("Expected failed Retry");

  act(() => untracked.retry());
  expect(loadDetail).toHaveBeenCalledTimes(1);
  expect(result.current).toMatchObject({ kind: "failed", recovering: false });

  act(() => failed.retry());
  expect(loadDetail).toHaveBeenCalledTimes(2);
  expect(result.current).toMatchObject({ kind: "failed", recovering: true });
});

function viewerShell() {
  return minimalProject({
    meta: {
      name: "Test Episode",
      workspace_dir: "/tmp/test",
      hydration: { transcript_words: false },
    },
  });
}

it("a Viewer with a granted flag and an incomplete shell loads detail once and becomes ready", async () => {
  const project = viewerShell();
  useDawStore
    .getState()
    .hydrate("share:tok", project, "view", ["play", "view"], null, true);
  resetDocumentAuthority("share:tok");
  documentAuthority.project = project;
  documentAuthority.token = "a".repeat(64);
  documentAuthority.phase = { kind: "ready" };
  const request = deferred<DocumentSnapshot>();
  loadDetail.mockReturnValueOnce(request.promise);
  const { result } = renderHook(useTranscriptDetail);
  expect(result.current.kind).toBe("pending");

  act(() => scheduleTranscriptDetailHydrate(project));
  expect(loadDetail).toHaveBeenCalledTimes(1);
  expect(loadDetail.mock.calls[0]?.[1]).toBe("detail");
  expect(result.current.kind).toBe("pending");

  await act(async () =>
    request.resolve({
      server_seq: 0,
      state_token: "a".repeat(64),
      project: minimalProject({
        meta: {
          name: "Test Episode",
          workspace_dir: "/tmp/test",
          hydration: { transcript_words: true },
        },
      }),
    }),
  );
  expect(result.current.kind).toBe("ready");
});

it("a flag of false is hidden and never loads detail", () => {
  const project = viewerShell();
  useDawStore
    .getState()
    .hydrate("share:tok", project, "view", ["play", "view"], null, false);
  resetDocumentAuthority("share:tok");
  loadDetail.mockClear();
  const { result } = renderHook(useTranscriptDetail);
  expect(result.current.kind).toBe("hidden");
  act(() => scheduleTranscriptDetailHydrate(project));
  expect(loadDetail).not.toHaveBeenCalled();
});
