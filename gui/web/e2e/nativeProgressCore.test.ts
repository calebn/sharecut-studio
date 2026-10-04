import { describe, expect, it } from "vitest";
import { pipelineEventsUrl } from "../src/api/pipeline";
import {
  BoundedRecords,
  type DomRecord,
  eventJob,
  NATIVE_PROGRESS_LIMITS,
  NativeProgressCore,
  nativeJob,
  nativeProgressSettings,
  pipelineRoute,
  reconstructMutations,
  statusJobs,
} from "./nativeProgressCore";

const job = (
  current: number | null = null,
  id = "native-1",
  status = "running",
) => ({
  id,
  kind: "pipeline",
  status,
  current,
  total: current === null ? null : 2,
  elapsed_sec: 0,
  steps: [],
});
const page = () => ({
  dom: [] as DomRecord[],
  geometry: [],
  issues: [],
  discarded: 0,
  callbackCount: 0,
  geometryReadCount: 0,
  styleReadCount: 0,
});
describe("passive native progress evidence", () => {
  it("selects passive natural-job observation by default and isolates explicit overhead control", () => {
    expect(
      nativeProgressSettings("progress-real", undefined, undefined),
    ).toEqual({ control: false, motion: "normal" });
    expect(
      nativeProgressSettings("progress-real", undefined, "reduce"),
    ).toEqual({ control: false, motion: "reduce" });
    expect(
      nativeProgressSettings("progress-real", "control-v2", "normal"),
    ).toEqual({ control: true, motion: "normal" });
    expect(
      nativeProgressSettings("progress-replay", undefined, undefined),
    ).toBeNull();
    for (const scene of ["progress-replay", "clip", undefined])
      expect(() =>
        nativeProgressSettings(scene, "control-v2", undefined),
      ).toThrow("require progress-real");
    expect(() =>
      nativeProgressSettings("progress-real", "passive-v2", undefined),
    ).toThrow("passive by default");
    expect(() =>
      nativeProgressSettings("progress-real", undefined, "unknown"),
    ).toThrow("normal or reduce");
  });
  it("grounds identity in the actual encoded native route and keeps unknown separate from zero", () => {
    const id = "native/with space";
    expect(pipelineRoute(pipelineEventsUrl(id))).toEqual({
      kind: "events",
      jobId: id,
    });
    expect(pipelineRoute("/api/pipeline/events?job_id=")).toBeNull();
    expect(pipelineRoute("/api/pipeline/events/elsewhere?job_id=1")).toBeNull();
    expect(nativeJob(job())?.percent).toBeNull();
    expect(nativeJob(job(0))?.percent).toBe(0);
    expect(nativeJob({ ...job(0), current: NaN })).toBeNull();
    expect(nativeJob({ ...job(0), total: -1 })).toBeNull();
    expect(statusJobs({})).toBeNull();
  });
  it("retains prebind receipts, POST and actual status as different possible inputs", () => {
    const core = new NativeProgressCore();
    core.input(
      "sse-network",
      eventJob(JSON.stringify({ type: "status", job: job(1) })),
      5,
      { requestId: "request-1", epoch: 1, jobId: "native-1" },
    );
    core.bind(job(), 100);
    core.status({ job: job(0) }, "consumer-status", 102);
    core.status({ jobs: [job(2, "native-1", "ok")] }, "driver-status", 103);
    core.recordTerminal(job(2, "native-1", "ok"));
    const evidence = core.evidence(page(), []);
    expect(evidence.inputs.map((input) => input.source)).toEqual([
      "sse-network",
      "post",
      "consumer-status",
      "driver-status",
    ]);
    expect(evidence.relations.zeroSources).toEqual(["consumer-status"]);
    expect(evidence.relations.firstDeterminateNetworkPercent).toBe(50);
    expect(evidence.relations.zeroDomMutationObserved).toBe(false);
    expect(evidence.relations.interpretation).toContain(
      "network receipt is not application acceptance",
    );
  });
  it("does not infer zero from a current connect snapshot at fifty", () => {
    const core = new NativeProgressCore();
    core.bind(job(), 0);
    core.input("sse-network", job(1), 1, {
      requestId: "stream",
      epoch: 1,
      jobId: "native-1",
    });
    core.input("sse-network", job(2, "native-1", "ok"), 2, {
      requestId: "stream",
      epoch: 1,
      jobId: "native-1",
    });
    const result = core.evidence(page(), []);
    expect(result.relations.zeroSources).toEqual([]);
    expect(result.relations.zeroQualifyingLayoutObserved).toBe(false);
    expect(result.producerEmissionCount.status).toBe("unavailable");
  });
  it("reconstructs same-batch oldValue chains by generation without calling mutations presented frames", () => {
    const mutation = (
      node: number,
      oldValue: string,
      finalValue: string,
    ): DomRecord => ({
      batch: 1,
      node,
      atMs: 20,
      kind: "attribute",
      attribute: "aria-valuenow",
      oldValue,
      valueAtDelivery: finalValue,
      reconstructedValue: null,
    });
    const records = [
      mutation(1, "0", "100"),
      mutation(2, "10", "90"),
      mutation(1, "50", "100"),
    ];
    expect(
      reconstructMutations(records).map((record) => record.reconstructedValue),
    ).toEqual(["50", "90", "100"]);
    const core = new NativeProgressCore();
    core.bind(job(), 0);
    const source = page();
    source.dom = records;
    const evidence = core.evidence(source, []);
    expect(evidence.relations.zeroDomMutationObserved).toBe(true);
    expect(evidence.relations.zeroQualifyingLayoutObserved).toBe(false);
    expect(evidence.geometry).toEqual([]);
  });
  it("invalidates binding for prebind or later competing jobs, mismatch and unavailable alternate input", () => {
    for (const before of [true, false]) {
      const core = new NativeProgressCore();
      if (before)
        core.status({ jobs: [job(0, "analyze-2")] }, "consumer-status", 0);
      core.bind(job(), 1);
      if (!before)
        core.status({ jobs: [job(0, "analyze-2")] }, "consumer-status", 2);
      expect(core.evidence(page(), []).binding.valid).toBe(false);
    }
    const core = new NativeProgressCore();
    core.bind(job(), 1);
    core.input("sse-network", job(0), 1, {
      requestId: "wrong",
      epoch: 2,
      jobId: "foreign",
    });
    core.status({}, "consumer-status", 2);
    core.bind(job(), 3);
    expect(core.evidence(page(), []).issues).toEqual([
      "SSE route/payload identity mismatch",
      "consumer-status: invalid status response; alternate input possible",
      "second or invalid POST binding",
      "required native SSE receipt unavailable; natural completion does not prove wire observation",
      "required native DOM observation unavailable; absence cannot prove skipped consumer state",
      "required geometry observation unavailable; no visible-layout conclusion",
    ]);
  });
  it("caps evidence, parser input and reasons while retaining an authoritative terminal separately", () => {
    const list = new BoundedRecords<number>(2);
    for (const value of [1, 2, 3, 4]) list.add(value);
    expect(list.records).toEqual([1, 2]);
    expect(list.discarded).toBe(2);
    const core = new NativeProgressCore();
    core.bind(job(), 0);
    for (let i = 0; i < NATIVE_PROGRESS_LIMITS.inputs; i++)
      core.input("driver-status", job(1), i);
    core.recordTerminal(job(2, "native-1", "ok"));
    expect(core.evidence(page(), []).terminal?.status).toBe("ok");
    expect(core.evidence(page(), []).binding.valid).toBe(false);
    expect(core.inputs.records).toHaveLength(NATIVE_PROGRESS_LIMITS.inputs);
    expect(() =>
      eventJob("x".repeat(NATIVE_PROGRESS_LIMITS.payloadChars + 1)),
    ).toThrow("oversized");
    expect(() => eventJob("not json")).toThrow();
    core.finished = true;
    const count = core.inputs.discarded;
    core.input("driver-status", job(1), 999);
    expect(core.inputs.discarded).toBe(count);
  });
  it("keeps genuine native completion separate from missing receipt and DOM channels", () => {
    const core = new NativeProgressCore();
    core.bind(job(), 0);
    core.recordTerminal(job(2, "native-1", "ok"));
    const evidence = core.evidence(page(), []);
    expect(evidence.naturalProcessing).toBe("succeeded");
    expect(evidence.binding.valid).toBe(false);
    expect(evidence.observationIntegrity).toBe("incomplete");
    expect(evidence.channelAvailability).toEqual({
      nativeReceipt: "unavailable",
      dom: "unavailable",
      geometry: "unavailable",
    });
    expect(evidence.relations.interpretation).toContain(
      "absence is not evidence",
    );
    expect(evidence.issues).toHaveLength(3);
  });
});
