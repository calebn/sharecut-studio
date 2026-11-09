import { beforeEach, describe, expect, it, vi } from "vitest";
import { getClipboard, setClipboard } from "../edit/clipboard";
import { useDawStore } from "../state/dawStore";
import {
  EDIT_SELECTIONS,
  editFixtureProject,
  MIRA,
} from "../test/actionBarFixtures";
import { deferred } from "../test/deferred";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { DocumentCommand } from "../types/documentCommands.generated";
import type { AutomationPoint, HistoryEntryId } from "../types/project";
import { currentEditFacts, runEditVerb } from "./editVerbs";
import { setEnvelopePoint } from "./envelopes";
import { clearRegisteredCommands, execute } from "./execute";
import { runAndAnnounceRefusal } from "./refusal";
import { registerDawCommands } from "./register";

const apiMocks = vi.hoisted(() => ({
  deleteClips: vi.fn(),
  rippleDeleteClips: vi.fn(),
  pasteSegment: vi.fn(),
  duplicateSegment: vi.fn(),
  setEnvelope: vi.fn(),
  submitDocumentCommand: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  deleteClips: apiMocks.deleteClips,
  rippleDeleteClips: apiMocks.rippleDeleteClips,
  pasteSegment: apiMocks.pasteSegment,
  duplicateSegment: apiMocks.duplicateSegment,
  setEnvelope: apiMocks.setEnvelope,
}));

vi.mock("../api/documentEdits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/documentEdits")>()),
  submitDocumentCommand: apiMocks.submitDocumentCommand,
}));

type Operation = {
  name: string;
  start: (request: ReturnType<typeof deferred<string>>) => Promise<unknown>;
  expectedMessage: string;
  expectedFailureMessage: string;
  expectedArgs: (path: string) => unknown;
};

const expectedCutClipboard = {
  mode: "cut",
  timelineStart: 0,
  timelineEnd: 4,
  trackIds: ["host"],
  extracts: [
    {
      track_id: "host",
      source_start: 0,
      source_end: 4,
      relative_timeline_start: 0,
      source_id: null,
      fade_in_ms: 0,
      fade_out_ms: 0,
      join_in_mode: "fade",
      mute_regions: [],
    },
  ],
};

const operationRows: Operation[] = [
  {
    name: "edit.delete clip",
    start: (request) => {
      apiMocks.deleteClips.mockReturnValue(request.promise);
      return runAndAnnounceRefusal(() =>
        execute("edit.delete", { clipId: "clip-a" }),
      );
    },
    expectedMessage: "Deleted clip",
    expectedFailureMessage: "Delete failed: request failed",
    expectedArgs: (path) => [path, ["clip-a"]],
  },
  {
    name: "edit.rippleDelete clip",
    start: (request) => {
      apiMocks.rippleDeleteClips.mockReturnValue(request.promise);
      return execute("edit.rippleDelete", { clipId: "clip-a" });
    },
    expectedMessage: "Ripple deleted clip",
    expectedFailureMessage: "Delete failed: request failed",
    expectedArgs: (path) => [path, ["clip-a"]],
  },
  {
    name: "edit.cut clip",
    start: (request) => {
      apiMocks.rippleDeleteClips.mockReturnValue(request.promise);
      return execute("edit.cut");
    },
    expectedMessage: "Cut to clipboard",
    expectedFailureMessage: "Cut failed: request failed",
    expectedArgs: (path) => [path, ["clip-a"]],
  },
  {
    name: "edit.paste duplicate segment",
    start: (request) => {
      setClipboard({
        mode: "copy",
        timelineStart: 0,
        timelineEnd: 4,
        extracts: [],
      });
      apiMocks.duplicateSegment.mockReturnValue(request.promise);
      return execute("edit.paste", { atTime: 20 });
    },
    expectedMessage: "Pasted at 00:20.000 (same track)",
    expectedFailureMessage: "Paste failed: request failed",
    expectedArgs: (path) => [path, 0, 4, 20],
  },
  {
    name: "edit.paste cut segment",
    start: (request) => {
      setClipboard({
        mode: "cut",
        timelineStart: 0,
        timelineEnd: 4,
        extracts: [
          {
            track_id: "host",
            source_start: 0,
            source_end: 4,
            relative_timeline_start: 0,
          },
        ],
      });
      apiMocks.pasteSegment.mockReturnValue(request.promise);
      return execute("edit.paste", { atTime: 20 });
    },
    expectedMessage: "Pasted at 00:20.000 (same track)",
    expectedFailureMessage: "Paste failed: request failed",
    expectedArgs: (path) => [
      path,
      20,
      4,
      [
        {
          track_id: "host",
          source_start: 0,
          source_end: 4,
          relative_timeline_start: 0,
        },
      ],
    ],
  },
  {
    name: "Actionbar envelope point remove",
    start: (request) => {
      apiMocks.setEnvelope.mockReturnValue(request.promise);
      const facts = currentEditFacts();
      if (!facts) throw new Error("Expected envelope point selection facts");
      return runEditVerb("remove", facts);
    },
    expectedMessage: "Envelope point removed",
    expectedFailureMessage: "request failed",
    expectedArgs: (path) => [
      path,
      "host",
      [],
      [{ id: "point-a", time: 2, value: 0.5 }],
    ],
  },
  {
    name: "envelope point set",
    start: (request) => {
      apiMocks.setEnvelope.mockReturnValue(request.promise);
      return setEnvelopePoint("host", "point-a", { value: 0.75 });
    },
    expectedMessage: "Envelope point changed",
    expectedFailureMessage: "request failed",
    expectedArgs: (path) => [
      path,
      "host",
      [{ id: "point-a", time: 2, value: 0.75 }],
      [{ id: "point-a", time: 2, value: 0.5 }],
    ],
  },
];

function projectFor(operation: Operation) {
  const envelope = operation.name.includes("envelope point")
    ? [
        {
          track_id: "host",
          parameter: "volume" as const,
          points: [{ id: "point-a", time: 2, value: 0.5 }],
        },
      ]
    : [];
  return minimalProject({
    tracks: [sampleTrack({ id: "host" })],
    clips: {
      tracks: {
        host: [
          clipRow({
            id: "clip-a",
            track_id: "host",
            source_start: 0,
            source_end: 4,
            timeline_start: 0,
            timeline_end: 4,
          }),
        ],
      },
      clip_count: 1,
    },
    envelopes: envelope,
  });
}

function selectionFor(operation: Operation) {
  return operation.name.includes("envelope point")
    ? { kind: "envelopePoint" as const, trackId: "host", pointId: "point-a" }
    : { kind: "clip" as const, id: "clip-a", trackId: "host" };
}

function seedOrigin(operation: Operation) {
  const path = "/projects/origin.sharecut";
  const project = projectFor(operation);
  useDawStore.getState().hydrate(path, project);
  useDawStore.getState().setSelection(selectionFor(operation));
  if (operation.name.includes("envelope point"))
    useDawStore.getState().setLayerVisible("showLevels", true);
  return path;
}

function seedReceivingProject(path: string, operation: Operation) {
  useDawStore.getState().hydrate(path, projectFor(operation));
  useDawStore.getState().setSelection(selectionFor(operation));
  useDawStore.getState().announceStatus("Project B saved later", {
    undo: "undo-project-b" as HistoryEntryId,
  });
  return useDawStore.getState().statusAnnouncementSeq;
}

function expectReceivingProjectUntouched(
  selection: ReturnType<typeof selectionFor>,
  announcementSeq: number,
) {
  const state = useDawStore.getState();
  expect({
    announcement: state.statusAnnouncement,
    toast: state.feedbackToast && {
      message: state.feedbackToast.message,
      undo: state.feedbackToast.undo,
      tone: state.feedbackToast.tone,
    },
    selection: state.selection,
    announcementSeq: state.statusAnnouncementSeq,
  }).toEqual({
    announcement: "Project B saved later",
    toast: {
      message: "Project B saved later",
      undo: "undo-project-b",
      tone: "status",
    },
    selection,
    announcementSeq,
  });
}

function successSelection(operation: Operation) {
  if (operation.name.includes("envelope point remove"))
    return { kind: "envelope" as const, trackId: "host" };
  if (operation.name.includes("envelope point set"))
    return selectionFor(operation);
  if (operation.name.includes("edit.paste")) return selectionFor(operation);
  return null;
}

function expectOperationStarted(operation: Operation, path: string) {
  const apiFn = apiMocks.deleteClips.mock.calls.length
    ? apiMocks.deleteClips
    : apiMocks.rippleDeleteClips.mock.calls.length
      ? apiMocks.rippleDeleteClips
      : apiMocks.pasteSegment.mock.calls.length
        ? apiMocks.pasteSegment
        : apiMocks.duplicateSegment.mock.calls.length
          ? apiMocks.duplicateSegment
          : apiMocks.setEnvelope;
  expect(apiFn.mock.calls[0]).toEqual(operation.expectedArgs(path));
}

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  vi.clearAllMocks();
  setClipboard(null);
});

describe.each(operationRows)(
  "project feedback lifetime: $name",
  (operation) => {
    it("keeps current-project success wording, Undo, and result semantics", async () => {
      const path = seedOrigin(operation);
      const request = deferred<string>();
      const pending = operation.start(request);
      expectOperationStarted(operation, path);
      const beforeSeq = useDawStore.getState().statusAnnouncementSeq;
      request.resolve("undo-origin");
      expect(await pending).toMatchObject({ status: "ok" });
      expect(useDawStore.getState().statusAnnouncement).toBe(
        operation.expectedMessage,
      );
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        message: operation.expectedMessage,
        undo: "undo-origin",
        tone: "status",
      });
      expect(useDawStore.getState().selection).toEqual(
        successSelection(operation),
      );
      expect(useDawStore.getState().statusAnnouncementSeq).toBe(beforeSeq + 1);
    });

    it("keeps current-project error wording, tone, and result semantics", async () => {
      seedOrigin(operation);
      const request = deferred<string>();
      const pending = operation.start(request);
      const beforeSeq = useDawStore.getState().statusAnnouncementSeq;
      request.reject(new Error("request failed"));
      const result = await pending;
      if (operation.name === "envelope point set") {
        expect(result).toEqual({
          status: "disabled",
          reason: "request failed",
          conflict: false,
        });
        expect(useDawStore.getState().statusAnnouncementSeq).toBe(beforeSeq);
        return;
      }
      expect(result).toMatchObject({
        status: "disabled",
        reason: "request failed",
        told: true,
      });
      expect(useDawStore.getState().statusAnnouncement).toBe(
        operation.expectedFailureMessage,
      );
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        message: operation.expectedFailureMessage,
        tone: "error",
        undo: null,
      });
      expect(useDawStore.getState().statusAnnouncementSeq).toBe(beforeSeq + 1);
      expect(useDawStore.getState().selection).toEqual(selectionFor(operation));
      if (operation.name === "edit.cut clip")
        expect(getClipboard()).toMatchObject(expectedCutClipboard);
    });

    it.each(["resolve", "reject"] as const)(
      "does not publish a late %s after a real different-path hydrate",
      async (settlement) => {
        const originPath = seedOrigin(operation);
        const request = deferred<string>();
        const pending = operation.start(request);
        expectOperationStarted(operation, originPath);
        const receivingSelection = selectionFor(operation);
        const receivingSeq = seedReceivingProject(
          "/projects/receiving.sharecut",
          operation,
        );
        if (settlement === "resolve") request.resolve("undo-origin");
        else request.reject(new Error("request failed"));
        const result = await pending;
        if (settlement === "reject") {
          if (operation.name === "envelope point set")
            expect(result).toMatchObject({
              status: "disabled",
              reason: "request failed",
              conflict: false,
            });
          else
            expect(result).toMatchObject({
              status: "disabled",
              reason: "request failed",
              told: true,
            });
        }
        if (settlement === "resolve") expect(result).toEqual({ status: "ok" });
        if (operation.name === "edit.cut clip")
          expect(getClipboard()).toMatchObject(expectedCutClipboard);
        expectReceivingProjectUntouched(receivingSelection, receivingSeq);
        expect(originPath).toBe("/projects/origin.sharecut");
      },
    );

    it.each(["resolve", "reject"] as const)(
      "does not publish a late %s after A to B to A hydration",
      async (settlement) => {
        const originPath = seedOrigin(operation);
        const originEpoch = useDawStore.getState().projectEpoch;
        const request = deferred<string>();
        const pending = operation.start(request);
        expectOperationStarted(operation, originPath);
        useDawStore
          .getState()
          .hydrate("/projects/other.sharecut", projectFor(operation));
        const receivingSeq = seedReceivingProject(originPath, operation);
        const receivingEpoch = useDawStore.getState().projectEpoch;
        expect(receivingEpoch).toBeGreaterThan(originEpoch);
        if (settlement === "resolve") request.resolve("undo-origin");
        else request.reject(new Error("request failed"));
        const result = await pending;
        if (settlement === "reject") {
          if (operation.name === "envelope point set")
            expect(result).toMatchObject({
              status: "disabled",
              reason: "request failed",
              conflict: false,
            });
          else
            expect(result).toMatchObject({
              status: "disabled",
              reason: "request failed",
              told: true,
            });
        }
        if (settlement === "resolve") expect(result).toEqual({ status: "ok" });
        if (operation.name === "edit.cut clip")
          expect(getClipboard()).toMatchObject(expectedCutClipboard);
        expectReceivingProjectUntouched(selectionFor(operation), receivingSeq);
      },
    );

    it("treats same-path hydration as the same project lifetime", async () => {
      const path = seedOrigin(operation);
      const epoch = useDawStore.getState().projectEpoch;
      const request = deferred<string>();
      const pending = operation.start(request);
      expectOperationStarted(operation, path);
      if (operation.name === "edit.cut clip")
        expect(getClipboard()).toMatchObject(expectedCutClipboard);
      useDawStore.getState().hydrate(path, projectFor(operation));
      expect(useDawStore.getState().projectEpoch).toBe(epoch);
      useDawStore.getState().setSelection(selectionFor(operation));
      request.resolve("undo-origin");
      expect(await pending).toMatchObject({ status: "ok" });
      expect(useDawStore.getState().statusAnnouncement).toBe(
        operation.expectedMessage,
      );
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        message: operation.expectedMessage,
        undo: "undo-origin",
        tone: "status",
      });
      expect(useDawStore.getState().selection).toEqual(
        successSelection(operation),
      );
    });
  },
);

describe("registered envelope.addPoint lifetime control", () => {
  it.each(["resolve", "reject"] as const)(
    "keeps the receiving project untouched after a late %s",
    async (settlement) => {
      const originPath = "/projects/envelope-origin.sharecut";
      useDawStore.getState().hydrate(
        originPath,
        minimalProject({
          tracks: [sampleTrack({ id: "host" })],
          timeline_duration_sec: 10,
          envelopes: [],
        }),
      );
      useDawStore.getState().setLayerVisible("showLevels", true);
      const request = deferred<HistoryEntryId>();
      apiMocks.setEnvelope.mockReturnValue(request.promise);
      const pending = execute("envelope.addPoint", {
        trackId: "host",
        atTime: 4,
      });
      const [path, trackId, points, origin] =
        apiMocks.setEnvelope.mock.calls[0]!;
      expect(path).toBe(originPath);
      expect(trackId).toBe("host");
      expect(
        (points as AutomationPoint[]).map(({ time, value }) => ({
          time,
          value,
        })),
      ).toEqual([
        { time: 0, value: 1 },
        { time: 4, value: 1 },
        { time: 10, value: 1 },
      ]);
      expect(origin).toEqual([]);

      useDawStore
        .getState()
        .hydrate(
          "/projects/envelope-receiving.sharecut",
          minimalProject({ tracks: [sampleTrack({ id: "host" })] }),
        );
      useDawStore.getState().setSelection({ kind: "track", trackId: "host" });
      useDawStore.getState().announceStatus("Receiving project status", {
        undo: "receiving-undo" as HistoryEntryId,
      });
      if (settlement === "resolve")
        request.resolve("undo-origin" as HistoryEntryId);
      else request.reject(new Error("request failed"));

      const result = await pending;
      if (settlement === "reject")
        expect(result).toMatchObject({
          status: "disabled",
          reason: "request failed",
          told: true,
        });
      else expect(result).toEqual({ status: "ok" });
      const state = useDawStore.getState();
      expect({
        announcement: state.statusAnnouncement,
        toast: state.feedbackToast && {
          message: state.feedbackToast.message,
          undo: state.feedbackToast.undo,
          tone: state.feedbackToast.tone,
        },
        selection: state.selection,
      }).toEqual({
        announcement: "Receiving project status",
        toast: {
          message: "Receiving project status",
          undo: "receiving-undo",
          tone: "status",
        },
        selection: { kind: "track", trackId: "host" },
      });
    },
  );
});

describe("Actionbar selected-range Cut diagnostic", () => {
  beforeEach(() => {
    const project = editFixtureProject();
    useDawStore.getState().hydrate("/projects/range-origin.sharecut", project);
    useDawStore.getState().setSelection(EDIT_SELECTIONS.rangeOnAllTracks);
  });

  it("keeps the receiving project announcement when the range request rejects late", async () => {
    const request = deferred<unknown>();
    apiMocks.submitDocumentCommand.mockReturnValue(request.promise);
    const facts = currentEditFacts();
    if (!facts) throw new Error("Expected selected-range facts");
    const target = useDawStore.getState().selection;
    if (target?.kind !== "range") throw new Error("Expected range selection");
    const pending = runEditVerb("cut", facts);
    expect(apiMocks.submitDocumentCommand.mock.calls[0]).toEqual([
      "/projects/range-origin.sharecut",
      DocumentCommand.EditSelectedRange,
      { action: "cut", targets: [target.target] },
    ]);
    useDawStore
      .getState()
      .hydrate(
        "/projects/range-receiving.sharecut",
        minimalProject({ tracks: [sampleTrack({ id: MIRA })] }),
      );
    useDawStore.getState().setSelection({
      kind: "track",
      trackId: MIRA,
    });
    useDawStore.getState().announceStatus("Receiving project status", {
      undo: "receiving-undo" as HistoryEntryId,
    });
    const receivingSeq = useDawStore.getState().statusAnnouncementSeq;
    request.reject(new Error("request failed"));
    expect(await pending).toEqual({
      status: "disabled",
      reason: "request failed",
      told: true,
    });
    const state = useDawStore.getState();
    expect({
      announcement: state.statusAnnouncement,
      toast: state.feedbackToast && {
        message: state.feedbackToast.message,
        undo: state.feedbackToast.undo,
        tone: state.feedbackToast.tone,
      },
      selection: state.selection,
      announcementSeq: state.statusAnnouncementSeq,
    }).toEqual({
      announcement: "Receiving project status",
      toast: {
        message: "Receiving project status",
        undo: "receiving-undo",
        tone: "status",
      },
      selection: { kind: "track", trackId: MIRA },
      announcementSeq: receivingSeq,
    });
  });
});
