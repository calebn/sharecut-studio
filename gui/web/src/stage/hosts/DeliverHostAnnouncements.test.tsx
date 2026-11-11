import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePipelineJob } from "../../hooks/usePipelineJob";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import {
  EXPORT_FINISHED,
  EXPORT_PATH,
  EXPORT_STARTED,
  fakeExportServer,
} from "../../test/fakeExportServer";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { StatusLive } from "../frame/StatusLive";
import { DeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";
import { ShareFlowProvider } from "./shareFlow";

const MP3 = { ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 };
const FILES = ["broadcast-a", "broadcast-b"];

type ReceiptMode = "valid" | "malformed";

function AppWithStatusDiscovery() {
  const stage = useDawStore((state) => state.stage);
  const pipelineJob = useDawStore((state) => state.pipelineJob);
  const activityJob = useDawStore((state) => state.activityJob);
  const setPipelineJob = useDawStore((state) => state.setPipelineJob);
  const setActivityJob = useDawStore((state) => state.setActivityJob);
  const setActivityRunningCount = useDawStore(
    (state) => state.setActivityRunningCount,
  );
  usePipelineJob(pipelineJob, setPipelineJob, {
    enabled: true,
    activityJob,
    setActivityJob,
    setActivityRunningCount,
  });

  return (
    <>
      <StatusLive />
      <ExportFlowProvider>
        <ShareFlowProvider>
          {stage === "deliver" ? <DeliverStage /> : <p>another stage</p>}
        </ShareFlowProvider>
      </ExportFlowProvider>
    </>
  );
}

async function flushPromises() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

describe("Deliver host result announcements with status discovery", () => {
  beforeEach(() => {
    useDawStore
      .getState()
      .hydrate(EXPORT_PATH, minimalProject({ tracks: [sampleTrack()] }));
    useDawStore.setState({
      stage: "deliver",
      guestMode: null,
      activityJob: null,
      pipelineJob: null,
      jobFeedback: new Map(),
      jobResultStarts: new Map(),
      feedbackToast: null,
      spokenJobResultIds: [],
      statusAnnouncement: "",
      statusAnnouncementSeq: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(["valid", "malformed"] as const)(
    "does not announce discovered export success before the %s receipt is handled",
    async (mode: ReceiptMode) => {
      vi.useFakeTimers();
      const start = deferred<void>();
      const server = fakeExportServer();
      server.holdStart = start.promise;
      const announcements: string[] = [];
      const unsubscribe = useDawStore.subscribe((state, previous) => {
        if (state.statusAnnouncementSeq !== previous.statusAnnouncementSeq) {
          announcements.push(state.statusAnnouncement);
        }
      });
      let view: ReturnType<typeof render> | undefined;
      let terminalJob: PipelineJobSnapshot = EXPORT_FINISHED;

      try {
        view = render(<AppWithStatusDiscovery />);
        await flushPromises();
        expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: /^Broadcast/ }));
        });
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Export" }));
        });
        await flushPromises();
        expect(server.exportRequests).toEqual([
          { path: EXPORT_PATH, formats: [MP3], target: "broadcast" },
        ]);

        const unrelated: PipelineJobSnapshot = {
          ...EXPORT_STARTED,
          id: "unowned-agent-job",
          kind: "agent",
          status: "ok",
          message: "Agent task",
        };
        const terminal = {
          ...EXPORT_FINISHED,
          result: {
            target: "broadcast",
            file_ids: FILES,
            edit_head_id: null,
            master: {
              within_tolerance: true,
              measured:
                mode === "valid"
                  ? { integrated_lufs: -23.1, true_peak_db: -1.4 }
                  : { integrated_lufs: -23.1 },
            },
          },
        };
        terminalJob = terminal;
        server.settled = unrelated;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(announcements).toContain("Activity finished. Agent task");

        server.settled = terminal;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(announcements).not.toContain(
          "Activity finished. Writing deliverables…",
        );
        expect(screen.getByRole("status")).toHaveTextContent(
          "Activity finished. Agent task",
        );

        start.resolve();
        await flushPromises();
        await act(async () => server.settle(terminal));
        await flushPromises();

        if (mode === "valid") {
          expect(announcements).toContain("Exported 2 Broadcast audio files.");
          expect(
            announcements.filter((message) =>
              message.includes("Exported 2 Broadcast audio files."),
            ),
          ).toHaveLength(1);
          expect(announcements).not.toContain(
            "Activity finished. Writing deliverables…",
          );
        } else {
          expect(screen.getByText("Export failed")).toBeVisible();
          const failure =
            "Export failed. The export result could not be verified. Try exporting again.";
          const episodeLinks = screen
            .getByRole("region", { name: "Episode file" })
            .querySelectorAll("a").length;
          await act(async () => {
            useDawStore.setState({ stage: "edit" });
          });
          expect(screen.queryByText("Export failed")).not.toBeInTheDocument();
          const liveFeedback = screen.getByRole("status").textContent?.trim();
          expect({
            failureAnnouncements: announcements.filter(
              (message) => message === failure,
            ),
            liveFeedback,
            episodeLinks,
            successAnnouncements: announcements.filter(
              (message) =>
                message === "Exported 2 Broadcast audio files." ||
                message === "Activity finished. Writing deliverables…",
            ),
          }).toEqual({
            failureAnnouncements: [failure],
            liveFeedback: failure,
            episodeLinks: 0,
            successAnnouncements: [],
          });
          expect(announcements).not.toContain(
            "Activity finished. Writing deliverables…",
          );
        }
      } finally {
        start.resolve();
        await act(async () => server.settle(terminalJob));
        view?.unmount();
        unsubscribe();
        vi.useRealTimers();
      }
    },
  );

  it("keeps a delivered receipt failure through delayed progress and success frames", async () => {
    vi.useFakeTimers();
    const start = deferred<void>();
    const server = fakeExportServer();
    server.holdStart = start.promise;
    const terminal = {
      ...EXPORT_FINISHED,
      result: { target: "broadcast", file_ids: FILES },
    };
    const view = render(<AppWithStatusDiscovery />);

    try {
      await flushPromises();
      const live = screen.getByRole("status");
      expect(live.textContent).toBe(
        "Activity is running. Writing deliverables…",
      );
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: /^Broadcast/ })),
      );
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Export" })),
      );
      expect(server.exportRequests).toEqual([
        { path: EXPORT_PATH, formats: [MP3], target: "broadcast" },
      ]);

      const seq = useDawStore.getState().statusAnnouncementSeq;
      server.settled = terminal;
      start.resolve();
      await flushPromises();
      expect(screen.getByText("Export failed")).toBeVisible();
      await act(async () => useDawStore.setState({ stage: "edit" }));
      expect(screen.queryByText("Export failed")).not.toBeInTheDocument();

      const failure =
        "Export failed. The export result could not be verified. Try exporting again.";
      expect(live.textContent).toBe(failure);
      expect(useDawStore.getState().statusAnnouncementSeq).toBe(seq + 1);
      const failureNode = live.firstElementChild;
      await act(async () =>
        server.settle({ ...EXPORT_STARTED, message: "Encoding audio…" }),
      );
      const afterProgress = live.textContent;
      const progressNode = live.firstElementChild;
      await act(async () => server.settle(terminal));
      const afterSuccess = live.textContent;
      const successNode = live.firstElementChild;
      const sequenceAfterSuccess = useDawStore.getState().statusAnnouncementSeq;

      server.settled = {
        ...EXPORT_FINISHED,
        id: "next-agent-job",
        kind: "agent",
        message: "Agent task",
      };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(live.textContent).toBe("Activity finished. Agent task");
      expect([afterProgress, afterSuccess]).toEqual([failure, failure]);
      expect(progressNode).toBe(failureNode);
      expect(successNode).toBe(failureNode);
      expect(sequenceAfterSuccess).toBe(seq + 1);
    } finally {
      start.resolve();
      view.unmount();
    }
  });

  it.each([
    { observation: "the first terminal frame", rediscover: false },
    { observation: "rediscovery at zero", rediscover: true },
  ])(
    "announces the deferred export's first count after $observation",
    async ({ rediscover }) => {
      vi.useFakeTimers();
      const start = deferred<void>();
      const server = fakeExportServer();
      server.holdStart = start.promise;
      const externalRunning: PipelineJobSnapshot = {
        ...EXPORT_STARTED,
        id: "external-export",
        message: "External export running",
      };
      server.started = externalRunning;
      const external: PipelineJobSnapshot = {
        ...EXPORT_FINISHED,
        id: externalRunning.id,
        message: "External export complete",
      };
      const agent: PipelineJobSnapshot = {
        ...EXPORT_STARTED,
        id: "older-agent",
        kind: "agent",
        message: "Agent task",
      };
      const local: PipelineJobSnapshot = {
        ...EXPORT_STARTED,
        id: "local-export",
      };
      const originalFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await originalFetch(input, init);
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (url.includes("/api/pipeline/status") && !server.settled) {
            return Response.json({
              ...(await response.json()),
              running_count: server.started === externalRunning ? 3 : 1,
            });
          }
          return response;
        }),
      );
      let view: ReturnType<typeof render> | undefined;

      try {
        view = render(<AppWithStatusDiscovery />);
        await flushPromises();
        const live = screen.getByRole("status");
        expect(live.textContent).toBe(
          "Activity is running. External export running. 3 activities",
        );
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Export" }));
        });
        await flushPromises();
        expect(server.exportRequests).toEqual([
          { path: EXPORT_PATH, formats: [MP3] },
        ]);

        await act(async () => server.settle(external));
        expect(live).not.toHaveTextContent("External export complete");

        if (rediscover) {
          server.reopen();
          server.started = agent;
          await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
          });
          expect(live.textContent).toBe("Activity is running. Agent task");

          server.settled = external;
          await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
          });
          expect(live.textContent).toBe("Activity is running. Agent task");
          expect(useDawStore.getState()).toMatchObject({
            activityJob: { id: external.id, status: "ok" },
            activityRunningCount: 0,
          });
        }

        server.started = local;
        server.reopen();
        start.resolve();
        await flushPromises();

        expect(useDawStore.getState().feedbackToast).toBeNull();
        expect(useDawStore.getState().spokenJobResultIds).toEqual([]);
        expect(live).toHaveTextContent(
          "Activity is running. Writing deliverables…",
        );
        expect(live).toHaveTextContent(
          "Activity finished. External export complete. 3 activities",
        );
      } finally {
        start.resolve();
        view?.unmount();
        vi.useRealTimers();
      }
    },
  );

  it("keeps an owned export failure after its status request fails and discovery sees malformed success", async () => {
    vi.useFakeTimers();
    const start = deferred<void>();
    const server = fakeExportServer();
    server.holdStart = start.promise;
    const realFetch = globalThis.fetch;
    let failFollowerStatus = false;
    let followerStatusFailures = 0;
    let malformedDiscoveryResponses = 0;
    const statusRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.includes("/api/pipeline/status")) {
          statusRequests.push(url);
          if (failFollowerStatus) {
            failFollowerStatus = false;
            followerStatusFailures += 1;
            return new Response("temporary status outage", { status: 503 });
          }
          if (
            followerStatusFailures === 1 &&
            server.settled?.id === EXPORT_STARTED.id &&
            server.settled.status === "ok"
          ) {
            malformedDiscoveryResponses += 1;
          }
        }
        return realFetch(input, init);
      }),
    );
    let view: ReturnType<typeof render> | undefined;
    const announcements: string[] = [];
    const unsubscribe = useDawStore.subscribe((state, previous) => {
      if (state.statusAnnouncementSeq !== previous.statusAnnouncementSeq) {
        announcements.push(state.statusAnnouncement);
      }
    });
    const malformed: PipelineJobSnapshot = {
      ...EXPORT_FINISHED,
      result: {
        target: "broadcast",
        file_ids: FILES,
        edit_head_id: null,
        master: {
          within_tolerance: true,
          measured: { integrated_lufs: -23.1 },
        },
      },
    };

    try {
      view = render(<AppWithStatusDiscovery />);
      await flushPromises();
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: /^Broadcast/ })),
      );
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Export" })),
      );
      await flushPromises();
      expect(server.exportRequests).toEqual([
        { path: EXPORT_PATH, formats: [MP3], target: "broadcast" },
      ]);

      failFollowerStatus = true;
      start.resolve();
      await flushPromises();
      expect(statusRequests).toHaveLength(2);
      expect(followerStatusFailures).toBe(1);
      expect(screen.getByText("Export failed")).toBeVisible();
      expect(screen.queryAllByRole("link")).toHaveLength(0);

      await act(async () =>
        server.settle({ ...EXPORT_STARTED, message: "Encoding audio…" }),
      );
      expect(screen.getByRole("status").textContent).toBe(
        "Activity is running. Encoding audio…",
      );

      server.settled = { ...malformed, id: EXPORT_STARTED.id };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(malformedDiscoveryResponses).toBeGreaterThan(0);
      expect(announcements).not.toContain(
        "Activity finished. Writing deliverables…",
      );
      expect(announcements).not.toContain("Exported 2 Broadcast audio files.");
      expect(screen.getByRole("status").textContent).toBe(
        "Activity is running. Encoding audio…",
      );
      expect(screen.getByText("Export failed")).toBeVisible();
      expect(screen.queryAllByRole("link")).toHaveLength(0);
    } finally {
      start.resolve();
      view?.unmount();
      unsubscribe();
      vi.useRealTimers();
    }
  });
});
