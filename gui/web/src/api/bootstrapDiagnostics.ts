import { apiFetch, HOST_KEY } from "./http";

export type DistributionMetadata = {
  support_url: string;
  report_available: boolean;
  privacy_url: string;
  repository_url: string;
  release_manifest_url: string | null;
};

export async function fetchDiagnosticsMeta(): Promise<DistributionMetadata> {
  const res = await apiFetch(HOST_KEY, { host: "/api/diagnostics" });
  return res.json() as Promise<DistributionMetadata>;
}

export type DiagnosticsBundleResult = {
  path: string;
  filename: string;
  support_url: string;
  size_bytes: number;
  files: string[];
  app_version: string;
  created_at: string;
};

export async function submitDiagnosticsReport(input: {
  filename: string;
  description: string;
  consent: boolean;
}): Promise<{ status: string; status_url: string }> {
  const res = await apiFetch(
    "",
    { host: "/api/diagnostics/submit" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return res.json() as Promise<{ status: string; status_url: string }>;
}

export async function fetchDiagnosticsReportStatus(
  url: string,
): Promise<{ status: string; issue_url: string | null }> {
  const res = await apiFetch("", {
    host: `/api/diagnostics/report-status?url=${encodeURIComponent(url)}`,
  });
  return res.json() as Promise<{ status: string; issue_url: string | null }>;
}

export async function createDiagnosticsBundle(opts?: {
  outDir?: string;
  path?: string;
}): Promise<DiagnosticsBundleResult> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/diagnostics/bundle" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        out_dir: opts?.outDir ?? null,
        path: opts?.path ?? null,
      }),
    },
  );
  return res.json() as Promise<DiagnosticsBundleResult>;
}
