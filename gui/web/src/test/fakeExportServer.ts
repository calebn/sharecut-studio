import { vi } from "vitest";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../types/pipeline";

export const EXPORT_PATH = "/tmp/ep/episode.project.json";

const EXPORT_CONFIG = {
  config: {
    export: {
      wav: true,
      formats: [{ ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 }],
    },
    master: { integrated_lufs: -16, true_peak_db: -1.5 },
  },
} as unknown as PipelineConfigResponse;

export const EXPORT_STARTED: PipelineJobSnapshot = {
  id: "x1",
  project_path: EXPORT_PATH,
  from_step: null,
  only_step: null,
  kind: "export",
  status: "running",
  current: 1,
  total: 2,
  message: "Writing deliverables…",
  error: null,
  elapsed_sec: 12,
  steps: [],
};

export const EXPORT_FINISHED: PipelineJobSnapshot = {
  ...EXPORT_STARTED,
  status: "ok",
  current: 2,
  result: {
    paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.mp3"],
    master: { measured: { integrated_lufs: -16.1, true_peak_db: -1.6 } },
  },
};

export const EXPORT_MODEL_NEEDED: PipelineJobSnapshot = {
  ...EXPORT_STARTED,
  status: "error",
  error: "needs RNNoise",
  error_code: "model_needed",
  error_model: {
    id: "rnnoise",
    variant: null,
    label: "Noise reduction (RNNoise)",
    purpose: "noise reduction",
    size: "~0.3 MB",
    sizeBytes: null,
    state: "missing",
  },
} as unknown as PipelineJobSnapshot;

class FakeEventSource {
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.all.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

type Answer = { status?: number; body?: unknown };

export function fakeExportServer() {
  const server = {
    config: EXPORT_CONFIG as unknown,
    configAnswer: null as Answer | null,
    startAnswer: null as Answer | null,
    holdStart: null as Promise<void> | null,
    holdConfig: null as Promise<void> | null,
    cancelAnswer: null as Answer | null,
    started: EXPORT_STARTED,
    settled: null as PipelineJobSnapshot | null,
    configRequests: [] as string[],
    exportRequests: [] as { path: string; formats: unknown }[],
    cancelRequests: [] as { job_id: string | null }[],
    settle(job: PipelineJobSnapshot) {
      server.settled = job;
      for (const source of FakeEventSource.all) {
        if (source.readyState !== FakeEventSource.CLOSED) {
          source.onmessage?.({ data: JSON.stringify({ job }) } as MessageEvent);
        }
      }
    },
    reopen() {
      server.settled = null;
    },
    watchers: () =>
      FakeEventSource.all.filter((s) => s.readyState !== FakeEventSource.CLOSED)
        .length,
  };
  FakeEventSource.all = [];
  const json = (answer: Answer | null, fallback: unknown) =>
    new Response(JSON.stringify(answer?.body ?? fallback), {
      status: answer?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (url.includes("/api/pipeline/config")) {
        server.configRequests.push(
          decodeURIComponent(url.split("path=")[1] ?? ""),
        );
        await server.holdConfig;
        return json(server.configAnswer, server.config);
      }
      if (url.includes("/api/export/deliverables")) {
        server.exportRequests.push(body);
        await server.holdStart;
        return json(server.startAnswer, { job: server.started });
      }
      if (url.includes("/api/pipeline/cancel")) {
        server.cancelRequests.push(body);
        return json(server.cancelAnswer, { job: server.started });
      }
      if (url.includes("/api/pipeline/status")) {
        return json(null, {
          running: server.settled === null,
          job: server.settled ?? server.started,
          jobs: [],
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return server;
}
