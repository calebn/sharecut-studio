import { vi } from "vitest";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../types/pipeline";
import type { HostShareRow } from "../types/shares";

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

export const BOUNCE_STARTED: PipelineJobSnapshot = {
  ...EXPORT_STARTED,
  id: "b1",
  kind: "bounce",
  message: "Bouncing…",
};

export const BOUNCE_FINISHED: PipelineJobSnapshot = {
  ...BOUNCE_STARTED,
  status: "ok",
  current: 2,
  result: { paths: ["/tmp/ep/export/bounces/ep.wav"] },
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

type Answer = { status?: number; body?: unknown; code?: string };

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
    bounceRequests: [] as Record<string, unknown>[],
    bounceAnswer: null as Answer | null,
    cancelRequests: [] as { job_id: string | null }[],
    /** The project's share rows, as `GET /api/shares` lists them. */
    shares: [] as HostShareRow[],
    shareListRequests: 0,
    shareRequests: [] as Record<string, unknown>[],
    /** Fails `POST /api/shares` (a refused create) when set. */
    shareAnswer: null as Answer | null,
    /** Holds `POST /api/shares` until released. */
    holdShare: null as Promise<void> | null,
    revokeRequests: [] as string[],
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
      headers: {
        "Content-Type": "application/json",
        ...(answer?.code ? { "X-Sharecut-Error-Code": answer.code } : {}),
      },
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
      if (url.includes("/api/shares")) {
        const method = init?.method ?? "GET";
        const revoked = /\/api\/shares\/([^/]+)\/revoke/.exec(url);
        if (revoked) {
          const token = decodeURIComponent(revoked[1]);
          server.revokeRequests.push(token);
          server.shares = server.shares.map((row) =>
            row.token === token
              ? { ...row, usable: false, revoked: true }
              : row,
          );
          return json(null, { ok: true });
        }
        if (method === "POST") {
          server.shareRequests.push(body);
          await server.holdShare;
          if (server.shareAnswer) return json(server.shareAnswer, {});
          const token = `made-link-${server.shareRequests.length}`;
          const row: HostShareRow = {
            token,
            url: `http://127.0.0.1:8765/r/${token}`,
            kind: "review",
            docs_role: body?.role ?? "commenter",
            mcp_url: body?.with_mcp
              ? `http://127.0.0.1:8765/mcp/${token}/mcp`
              : null,
            usable: true,
            invite_closed: null,
            review_version_label: "Share mix",
            follow_latest: !body?.freeze,
          };
          server.shares = [...server.shares, row];
          return json(null, { share: row });
        }
        server.shareListRequests += 1;
        return json(null, {
          shares: server.shares,
          public_origin: "http://127.0.0.1:8765",
        });
      }
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
      if (url.includes("/api/export/bounce")) {
        server.bounceRequests.push(body);
        return json(server.bounceAnswer, { job: BOUNCE_STARTED });
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
