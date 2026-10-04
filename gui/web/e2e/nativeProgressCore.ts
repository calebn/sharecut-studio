import { pipelineProgressPercent } from "../src/utils/pipelineProgress";

export const NATIVE_PROGRESS_PROTOCOL = "native-progress-passive-v2";
export const NATIVE_PROGRESS_LIMITS = {
  inputs: 4096,
  requests: 256,
  pendingBodies: 32,
  dom: 2048,
  geometry: 4096,
  nodes: 256,
  issues: 128,
  payloadChars: 65536,
  ancestors: 32,
} as const;
export type NativeJob = {
  id: string;
  kind: string;
  status: string;
  current: number | null;
  total: number | null;
  percent: number | null;
  elapsedSec: number | null;
  steps: { name: string; status: string; elapsedSec: number | null }[];
};
export type InputSource =
  | "post"
  | "sse-network"
  | "consumer-status"
  | "driver-status";
export type NativeInput = {
  source: InputSource;
  clock: "cdp-monotonic-seconds" | "driver-monotonic-ms";
  at: number;
  job: NativeJob;
  requestId?: string;
  streamEpoch?: number;
};
export type DomRecord = {
  batch: number;
  node: number;
  atMs: number;
  kind: "added" | "removed" | "attribute" | "indeterminate" | "headline";
  attribute: string | null;
  oldValue: string | null;
  valueAtDelivery: string | null;
  reconstructedValue: string | null;
};
export type GeometryRecord = {
  node: number;
  atMs: number;
  trigger: string;
  percent: number | null;
  width: number;
  fillWidth: number | null;
  height: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  viewportHeight: number;
  viewportWidth: number;
  visibleIntersection: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  qualification: "qualifying-rectangular-layout" | "excluded" | "unknown";
  ancestorsChecked: number;
  clippingAncestors: {
    depth: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
    clipX: boolean;
    clipY: boolean;
  }[];
  styleReadCount: number;
  excluded: string[];
};
export class BoundedRecords<T> {
  readonly records: T[] = [];
  discarded = 0;
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  add(record: T) {
    if (this.records.length >= this.limit) {
      this.discarded++;
      return false;
    }
    this.records.push(record);
    return true;
  }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function nullableFinite(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}
export function nativeJob(value: unknown): NativeJob | null {
  const job = object(value);
  if (
    !job ||
    typeof job.id !== "string" ||
    !job.id ||
    job.id.length > 128 ||
    typeof job.status !== "string" ||
    !["queued", "running", "ok", "error", "cancelled"].includes(job.status) ||
    !nullableFinite(job.current) ||
    !nullableFinite(job.total) ||
    (job.current !== null && job.current < 0) ||
    (job.total !== null && job.total < 0)
  )
    return null;
  const steps = Array.isArray(job.steps) ? job.steps : [];
  if (steps.length > 64) return null;
  return {
    id: job.id,
    kind: typeof job.kind === "string" ? job.kind.slice(0, 128) : "pipeline",
    status: job.status,
    current: job.current,
    total: job.total,
    percent: pipelineProgressPercent({
      current: job.current,
      total: job.total,
    }),
    elapsedSec:
      typeof job.elapsed_sec === "number" && Number.isFinite(job.elapsed_sec)
        ? job.elapsed_sec
        : null,
    steps: steps.map((step: unknown) => {
      const value = object(step);
      return {
        name:
          typeof value?.name === "string"
            ? value.name.slice(0, 128)
            : "unknown",
        status:
          typeof value?.status === "string"
            ? value.status.slice(0, 128)
            : "unknown",
        elapsedSec:
          typeof value?.elapsed_sec === "number" &&
          Number.isFinite(value.elapsed_sec)
            ? value.elapsed_sec
            : null,
      };
    }),
  };
}
export function statusJobs(value: unknown): unknown[] | null {
  const payload = object(value);
  if (!payload) return null;
  if (Array.isArray(payload.jobs))
    return payload.jobs.length <= 64 ? payload.jobs : null;
  if (!("job" in payload)) return null;
  return payload.job == null ? [] : [payload.job];
}
export function eventJob(text: string): unknown {
  if (text.length > NATIVE_PROGRESS_LIMITS.payloadChars)
    throw new Error("oversized native event payload");
  const value = object(JSON.parse(text));
  if (!value || !("job" in value))
    throw new Error("native event without job snapshot");
  return value.job;
}
export function pipelineRoute(
  raw: string,
): { kind: "events" | "status" | "run"; jobId: string | null } | null {
  try {
    const url = new URL(raw, "http://localhost");
    const kind =
      url.pathname === "/api/pipeline/events"
        ? "events"
        : url.pathname === "/api/pipeline/status"
          ? "status"
          : url.pathname === "/api/pipeline/run"
            ? "run"
            : null;
    const id = url.searchParams.get("job_id");
    if (!kind || (id !== null && (!id || id.length > 128))) return null;
    return { kind, jobId: id };
  } catch {
    return null;
  }
}
export function reconstructMutations(records: DomRecord[]): DomRecord[] {
  return records.map((record, i) => {
    if (record.kind !== "attribute") return record;
    const next = records
      .slice(i + 1)
      .find(
        (entry) =>
          entry.batch === record.batch &&
          entry.node === record.node &&
          entry.kind === "attribute" &&
          entry.attribute === record.attribute,
      );
    return {
      ...record,
      reconstructedValue: next ? next.oldValue : record.valueAtDelivery,
    };
  });
}
export class NativeProgressCore {
  readonly inputs = new BoundedRecords<NativeInput>(
    NATIVE_PROGRESS_LIMITS.inputs,
  );
  readonly issues = new BoundedRecords<string>(NATIVE_PROGRESS_LIMITS.issues);
  jobId: string | null = null;
  terminal: NativeJob | null = null;
  finished = false;
  note(reason: string) {
    this.issues.add(reason.slice(0, 512));
  }
  input(
    source: InputSource,
    raw: unknown,
    at: number,
    stream?: { requestId: string; epoch: number; jobId: string | null },
  ) {
    if (this.finished) return;
    const job = nativeJob(raw);
    if (!job) {
      this.note(`${source}: invalid job snapshot`);
      return;
    }
    if (stream && stream.jobId !== job.id) {
      this.note("SSE route/payload identity mismatch");
      return;
    }
    if (
      !this.inputs.add({
        source,
        job,
        at,
        clock:
          source === "sse-network"
            ? "cdp-monotonic-seconds"
            : "driver-monotonic-ms",
        ...(stream
          ? { requestId: stream.requestId, streamEpoch: stream.epoch }
          : {}),
      })
    )
      return;
    if (
      this.jobId &&
      job.id !== this.jobId &&
      ["queued", "running"].includes(job.status)
    )
      this.note("competing active job invalidates DOM binding");
  }
  bind(raw: unknown, at: number) {
    if (this.finished) return;
    const job = nativeJob(raw);
    if (this.jobId || !job) {
      this.note("second or invalid POST binding");
      return;
    }
    this.jobId = job.id;
    this.input("post", raw, at);
    if (
      this.inputs.records.some(
        (entry) =>
          entry.job.id !== job.id &&
          ["queued", "running"].includes(entry.job.status),
      )
    )
      this.note("prebind competing active job invalidates DOM binding");
  }
  status(
    raw: unknown,
    source: "consumer-status" | "driver-status",
    at: number,
  ) {
    if (this.finished) return;
    const jobs = statusJobs(raw);
    if (!jobs) {
      this.note(`${source}: invalid status response; alternate input possible`);
      return;
    }
    for (const job of jobs) this.input(source, job, at);
  }
  recordTerminal(raw: unknown) {
    if (this.finished) return;
    const job = nativeJob(raw);
    if (
      !job ||
      job.id !== this.jobId ||
      !["ok", "error", "cancelled"].includes(job.status)
    ) {
      this.note("invalid backend terminal identity/status");
      return;
    }
    this.terminal = job;
  }
  evidence(
    page: {
      dom: DomRecord[];
      geometry: GeometryRecord[];
      issues: string[];
      discarded: number;
      callbackCount: number;
      geometryReadCount: number;
      styleReadCount: number;
    },
    cleanupFailures: string[],
    control = false,
  ) {
    const issues = [...this.issues.records, ...page.issues, ...cleanupFailures];
    if (!this.jobId) issues.push("POST identity unavailable");
    if (this.inputs.discarded || this.issues.discarded || page.discarded)
      issues.push("bounded channel truncated");
    const inputs = this.inputs.records.filter(
      (entry) => entry.job.id === this.jobId,
    );
    const dom = reconstructMutations(page.dom);
    const geometry = page.geometry;
    const geometrySampleRuns: {
      node: number;
      percent: number | null;
      first: GeometryRecord;
      last: GeometryRecord;
      samples: number;
      qualifyingSamples: number;
    }[] = [];
    for (const sample of geometry) {
      const previous = geometrySampleRuns.at(-1);
      if (
        previous &&
        previous.node === sample.node &&
        previous.percent === sample.percent
      ) {
        previous.last = sample;
        previous.samples++;
        previous.qualifyingSamples += sample.excluded.length ? 0 : 1;
      } else
        geometrySampleRuns.push({
          node: sample.node,
          percent: sample.percent,
          first: sample,
          last: sample,
          samples: 1,
          qualifyingSamples: sample.excluded.length ? 0 : 1,
        });
    }
    const zeroDom = dom.some(
      (entry) =>
        entry.attribute === "aria-valuenow" &&
        [
          entry.oldValue,
          entry.valueAtDelivery,
          entry.reconstructedValue,
        ].includes("0"),
    );
    const zeroLayout = geometry.some(
      (entry) => entry.percent === 0 && !entry.excluded.length,
    );
    const receipts = inputs.filter((entry) => entry.source === "sse-network");
    const channelAvailability = {
      nativeReceipt: control
        ? "disabled-control"
        : receipts.length > 0
          ? "observed"
          : "unavailable",
      dom: control
        ? "disabled-control"
        : dom.some(
              (entry) =>
                entry.kind !== "indeterminate" ||
                entry.valueAtDelivery === "true",
            )
          ? "observed"
          : "unavailable",
      geometry: control
        ? "disabled-control"
        : geometry.length > 0
          ? "observed"
          : "unavailable",
    };
    if (channelAvailability.nativeReceipt === "unavailable")
      issues.push(
        "required native SSE receipt unavailable; natural completion does not prove wire observation",
      );
    if (channelAvailability.dom === "unavailable")
      issues.push(
        "required native DOM observation unavailable; absence cannot prove skipped consumer state",
      );
    if (channelAvailability.geometry === "unavailable")
      issues.push(
        "required geometry observation unavailable; no visible-layout conclusion",
      );
    if (geometry.some((entry) => entry.qualification === "unknown"))
      issues.push(
        "geometry qualification unknown; clipping/visibility completeness unavailable",
      );
    const zeroSources = [
      ...new Set(
        inputs
          .filter((entry) => entry.job.percent === 0)
          .map((entry) => entry.source),
      ),
    ];
    return {
      protocol: NATIVE_PROGRESS_PROTOCOL,
      binding: {
        method: "exclusive-session-inferred; no DOM job-id attribute",
        jobId: this.jobId,
        valid: !control && !issues.length,
      },
      clocks:
        "CDP monotonic seconds and document/driver performance milliseconds retained separately; no exact cross-clock latency",
      inputs: this.inputs.records,
      inputsDiscarded: this.inputs.discarded,
      dom,
      geometry,
      geometrySampleRuns,
      channelAvailability,
      geometryMethod:
        "consecutive sampled node/value runs; first/last sampled only, not every logical interval or presented frame; observer window extends beyond action",
      issues,
      issuesDiscarded: this.issues.discarded,
      pageDiscarded: page.discarded,
      terminal: this.terminal,
      naturalProcessing:
        this.terminal?.status === "ok" ? "succeeded" : "not-established",
      observationIntegrity: control
        ? "disabled-control"
        : issues.length
          ? "incomplete"
          : "complete-within-observer-window",
      cleanupFailures,
      callbackCount: page.callbackCount,
      geometryReadCount: page.geometryReadCount,
      styleReadCount: page.styleReadCount,
      crossChannelAbsenceInference: {
        status: "unavailable",
        reason:
          "separate clock domains and channel cutoffs; no absence joins outside a proven common window",
      },
      relations: {
        zeroSources,
        zeroDomMutationObserved: zeroDom,
        zeroQualifyingLayoutObserved: zeroLayout,
        firstDeterminateNetworkPercent:
          receipts.find((entry) => entry.job.percent !== null)?.job.percent ??
          null,
        interpretation: issues.length
          ? "inconclusive: observer/identity incomplete; absence is not evidence; network receipt is not application acceptance"
          : "channel observations only; POST/status/SSE are possible inputs; network receipt is not application acceptance; absent producer history cannot be reconstructed",
      },
      producerEmissionCount: {
        status: "unavailable",
        reason: "producer not instrumented",
      },
    };
  }
}
