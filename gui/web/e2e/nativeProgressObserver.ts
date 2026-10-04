import type { CDPSession, Page, Response } from "@playwright/test";
import {
  BoundedRecords,
  eventJob,
  NATIVE_PROGRESS_LIMITS,
  NativeProgressCore,
  pipelineRoute,
} from "./nativeProgressCore";
import {
  installNativeProgressPage,
  type NativePageEvidence,
} from "./nativeProgressPage";

function emptyPage(): NativePageEvidence {
  return {
    dom: [],
    geometry: [],
    issues: [],
    discarded: 0,
    callbackCount: 0,
    geometryReadCount: 0,
    styleReadCount: 0,
    documentEpoch: "unavailable",
    startedAtMs: 0,
    finishedAtMs: null,
    unsampledOnFinish: false,
  };
}
export async function retainNativeProgress<T>(
  primaryFailure: unknown,
  finish: () => Promise<T>,
  attach: (value: T) => Promise<void>,
  reportSecondary: (failure: unknown) => void,
) {
  try {
    await attach(await finish());
  } catch (error) {
    reportSecondary(error);
    if (primaryFailure === undefined) throw error;
  }
}
export async function armNativeProgress(page: Page, control = false) {
  const driverArmedAtMs = performance.now();
  const core = new NativeProgressCore();
  const cleanupFailures: string[] = [];
  const requests = new Map<
    string,
    { jobId: string | null; epoch: number; native: boolean }
  >();
  const transportEvents = new BoundedRecords<{
    requestId: string;
    kind: string;
    reason: string;
    at: number | null;
  }>(NATIVE_PROGRESS_LIMITS.requests);
  let epoch = 0;
  let cdp: CDPSession | undefined;
  let accepting = true;
  let closed = false;
  let pageInstalled = false;
  let available = false;
  let finishPromise:
    | Promise<
        ReturnType<NativeProgressCore["evidence"]> & {
          documentEpoch: string;
          control: boolean;
          unsampledOnFinish: boolean;
          transportEvents: {
            requestId: string;
            kind: string;
            reason: string;
            at: number | null;
          }[];
          windows: {
            driverArmedAtMs: number;
            driverFinishRequestedAtMs: number;
            driverClosedAtMs: number;
            pageStartedAtMs: number;
            pageFinishedAtMs: number | null;
          };
        }
      >
    | undefined;
  const pending = new Set<Promise<void>>();
  const recordError = (error: unknown) =>
    core.note(
      `observer: ${error instanceof Error ? error.message : String(error)}`,
    );
  const onRequest = (event: {
    requestId: string;
    request: { url: string };
    type?: string;
  }) => {
    if (!accepting) return;
    const route = pipelineRoute(event.request.url);
    if (route?.kind !== "events" && event.type !== "EventSource") return;
    if (
      !requests.has(event.requestId) &&
      requests.size >= NATIVE_PROGRESS_LIMITS.requests
    ) {
      core.note("request identity map capped");
      return;
    }
    requests.set(event.requestId, {
      jobId: route?.jobId ?? null,
      epoch: ++epoch,
      native: route?.kind === "events",
    });
  };
  const onMessage = (event: {
    requestId: string;
    timestamp: number;
    data: string;
  }) => {
    if (!accepting) return;
    const request = requests.get(event.requestId);
    if (!request) {
      core.note(
        "unmapped native EventSource receipt; alternate input possible",
      );
      return;
    }
    if (!request.native) return;
    try {
      core.input("sse-network", eventJob(event.data), event.timestamp, {
        requestId: event.requestId,
        jobId: request.jobId,
        epoch: request.epoch,
      });
    } catch (error) {
      recordError(error);
    }
  };
  const transport = (
    kind: string,
    event: { requestId: string; timestamp?: number; errorText?: string },
  ) => {
    if (
      accepting &&
      requests.get(event.requestId)?.native &&
      !transportEvents.add({
        requestId: event.requestId,
        kind,
        reason: event.errorText?.slice(0, 256) ?? "",
        at: event.timestamp ?? null,
      })
    )
      core.note("transport event channel capped");
  };
  const onCompleted = (event: { requestId: string; timestamp?: number }) =>
    transport("finished", event);
  const onFailed = (event: {
    requestId: string;
    timestamp?: number;
    errorText?: string;
  }) => transport("failed-or-cancelled", event);
  const onResponse = (response: Response) => {
    if (!accepting) return;
    const route = pipelineRoute(response.url());
    if (!route || route.kind !== "status") return;
    if (pending.size >= NATIVE_PROGRESS_LIMITS.pendingBodies) {
      core.note("passive status bodies capped; alternate input possible");
      return;
    }
    const at = performance.now();
    const task = (async () => {
      try {
        const length = Number(response.headers()["content-length"]);
        if (
          Number.isFinite(length) &&
          length > NATIVE_PROGRESS_LIMITS.payloadChars
        )
          throw new Error("passive status payload oversized");
        const text = await response.text();
        if (closed) return;
        if (text.length > NATIVE_PROGRESS_LIMITS.payloadChars)
          throw new Error("passive status payload oversized");
        core.status(JSON.parse(text), "consumer-status", at);
      } catch (error) {
        if (!closed) recordError(error);
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  const onNavigation = () => {
    if (accepting)
      core.note("document/frame navigation makes DOM binding ambiguous");
  };
  const finish = () => {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      const driverFinishRequestedAtMs = performance.now();
      accepting = false;
      let pageEvidence = emptyPage();
      const cleanup = async (label: string, action: () => unknown) => {
        try {
          await action();
        } catch (error) {
          cleanupFailures.push(`${label}: ${String(error).slice(0, 512)}`);
        }
      };
      await cleanup("response listener", () =>
        page.off("response", onResponse),
      );
      await cleanup("navigation listener", () =>
        page.off("framenavigated", onNavigation),
      );
      if (pageInstalled)
        await cleanup("page observer drain/detach", async () => {
          pageEvidence = await page.evaluate(() => {
            if (!window.__nativeProgressObserver)
              throw new Error("page observer/document unavailable");
            return window.__nativeProgressObserver.finish();
          });
        });
      if (!control && !pageInstalled) core.note("page observer unavailable");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await cleanup("passive status drain", async () => {
        await Promise.race([
          Promise.all([...pending]),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "passive status drain timed out; alternate input possible",
                  ),
                ),
              5000,
            );
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
      });
      if (cdp) {
        const session = cdp;
        await cleanup("CDP request listener", () =>
          session.off("Network.requestWillBeSent", onRequest),
        );
        await cleanup("CDP receipt listener", () =>
          session.off("Network.eventSourceMessageReceived", onMessage),
        );
        await cleanup("CDP finish listener", () =>
          session.off("Network.loadingFinished", onCompleted),
        );
        await cleanup("CDP failure listener", () =>
          session.off("Network.loadingFailed", onFailed),
        );
        await cleanup("owned CDP session", () => session.detach());
      }
      closed = true;
      core.finished = true;
      requests.clear();
      return {
        ...core.evidence(pageEvidence, cleanupFailures, control),
        documentEpoch: pageEvidence.documentEpoch,
        control,
        unsampledOnFinish: pageEvidence.unsampledOnFinish,
        transportEvents: transportEvents.records,
        windows: {
          driverArmedAtMs,
          driverFinishRequestedAtMs,
          driverClosedAtMs: performance.now(),
          pageStartedAtMs: pageEvidence.startedAtMs,
          pageFinishedAtMs: pageEvidence.finishedAtMs,
        },
      };
    })();
    return finishPromise;
  };
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    if (!control) {
      cdp.on("Network.requestWillBeSent", onRequest);
      cdp.on("Network.eventSourceMessageReceived", onMessage);
      cdp.on("Network.loadingFinished", onCompleted);
      cdp.on("Network.loadingFailed", onFailed);
      page.on("response", onResponse);
      page.on("framenavigated", onNavigation);
      pageInstalled = true;
      await page.evaluate(installNativeProgressPage, NATIVE_PROGRESS_LIMITS);
    }
    available = true;
  } catch (error) {
    recordError(error);
    await finish();
  }
  return { core, finish, control, available };
}
