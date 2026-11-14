import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { submitDocumentCommand } from "../../api/documentEdits";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import {
  COMMENTER_CAPABILITIES,
  clipRow,
  EDITOR_CAPABILITIES,
  minimalProject,
  sampleTrack,
} from "../../test/fixtures";
import { StoredGuestScriptHost } from "../../test/StoredGuestScriptHost";
import { seedScript } from "../../test/scriptHostKit";
import { stubViewportShell } from "../../test/viewportShell";
import type { HistoryEntryId } from "../../types/project";

vi.mock("../../api/documentEdits", async (original) => ({
  ...(await original<typeof import("../../api/documentEdits")>()),
  submitDocumentCommand: vi.fn(),
}));

const project = minimalProject({ tracks: [sampleTrack({ id: "host" })] });
const clips = {
  tracks: {
    host: [
      clipRow({
        id: "clip-a",
        track_id: "host",
        timeline_start: 0,
        timeline_end: 30,
        source_start: 0,
        source_end: 30,
      }),
    ],
  },
  clip_count: 1,
};

describe.each([
  {
    guestMode: "comment",
    caps: COMMENTER_CAPABILITIES,
    label: "Suggest a cut",
  },
  { guestMode: "edit", caps: EDITOR_CAPABILITIES, label: "Cut" },
])("guest Review $label", ({ guestMode, caps, label }) => {
  it.each([false, true])(
    "announces a refusal only while its origin remains current (switch=%s)",
    async (switchProject) => {
      stubViewportShell("desktop");
      const request = deferred<Record<string, unknown>>();
      const submit = vi.mocked(submitDocumentCommand);
      submit.mockReset();
      submit.mockReturnValue(request.promise);
      seedScript({
        projectPath: "share:fake-origin",
        guestMode,
        shareCapabilities: caps,
        project: { clips },
      });
      render(createElement(StoredGuestScriptHost));
      act(() =>
        useDawStore.getState().setSelection({
          kind: "transcriptRange",
          trackId: "host",
          sourceId: null,
          startWordIndex: 0,
          endWordIndex: 1,
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(submit).toHaveBeenCalledExactlyOnceWith(
        "share:fake-origin",
        "EditSelectedRange",
        {
          action: "cut",
          targets: [expect.objectContaining({ track_ids: ["host"] })],
        },
      );

      const epoch = useDawStore.getState().projectEpoch;
      if (switchProject) {
        act(() =>
          useDawStore.getState().hydrate("share:fake-receiving", project),
        );
        expect(useDawStore.getState().projectEpoch).toBe(epoch + 1);
      }
      act(() =>
        useDawStore.getState().announceStatus("Current project saved", {
          undo: "undo-receiving" as HistoryEntryId,
        }),
      );
      const before = useDawStore.getState().statusAnnouncementSeq;
      await act(async () =>
        request.reject(new Error("Origin range request failed")),
      );

      const state = useDawStore.getState();
      expect({
        path: state.projectPath,
        message: state.statusAnnouncement,
        toast: state.feedbackToast?.message,
        tone: state.feedbackToast?.tone,
        undo: state.feedbackToast?.undo,
        announcements: state.statusAnnouncementSeq - before,
      }).toEqual(
        switchProject
          ? {
              path: "share:fake-receiving",
              message: "Current project saved",
              toast: "Current project saved",
              tone: "status",
              undo: "undo-receiving",
              announcements: 0,
            }
          : {
              path: "share:fake-origin",
              message: "Origin range request failed",
              toast: "Origin range request failed",
              tone: "error",
              undo: null,
              announcements: 1,
            },
      );
    },
  );
});
