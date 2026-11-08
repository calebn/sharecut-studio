import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject } from "../test/fixtures";
import { resetDocumentAuthority } from "./authorityState";
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
    .hydrate("share:tok", project, "comment", ["view", "comment", "suggest"]);
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
