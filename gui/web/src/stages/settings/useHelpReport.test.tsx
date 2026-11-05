import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiagnosticsBundle,
  fetchDiagnosticsMeta,
  submitDiagnosticsReport,
} from "../../api";
import { clearOutbox, outboxState } from "./helpOutbox";
import { useHelpReport } from "./useHelpReport";

vi.mock("../../api", () => ({
  createDiagnosticsBundle: vi.fn(),
  fetchDiagnosticsMeta: vi.fn(),
  submitDiagnosticsReport: vi.fn(),
}));

const create = vi.mocked(createDiagnosticsBundle);
const meta = vi.mocked(fetchDiagnosticsMeta);
const submit = vi.mocked(submitDiagnosticsReport);

const BUNDLE = {
  path: "/Users/ada/Downloads/sharecut-diagnostics-1.zip",
  filename: "sharecut-diagnostics-1.zip",
  support_url: "https://github.com/calebn/sharecut-studio/issues",
  size_bytes: 2048,
  files: ["doctor.txt", "logs/studio.log"],
  app_version: "0.1.1",
  created_at: "2026-11-05T00:00:00Z",
};
const DESCRIPTION = "Export stops at forty percent";

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
}

function mount(open = true) {
  return renderHook(({ open }) => useHelpReport(open), {
    initialProps: { open },
  });
}

async function describe_(result: ReturnType<typeof mount>["result"]) {
  await waitFor(() => expect(meta).toHaveBeenCalled());
  act(() => result.current.setDescription(DESCRIPTION));
}

beforeEach(() => {
  create.mockReset().mockResolvedValue(BUNDLE);
  submit.mockReset().mockResolvedValue({
    status: "queued",
    status_url: "https://relay.example.test/api/reports/Zk3Lm9QxPw27",
  });
  meta.mockReset().mockResolvedValue({
    report_available: true,
    support_url: BUNDLE.support_url,
    privacy_url: "",
    repository_url: "",
    release_manifest_url: null,
  });
  setOnline(true);
});

afterEach(async () => {
  setOnline(true);
  window.dispatchEvent(new Event("online"));
  await waitFor(() =>
    expect(["waiting", "sending"]).not.toContain(outboxState().kind),
  );
  clearOutbox();
});

describe("useHelpReport", () => {
  it("waits for a description before Send report", () => {
    const { result } = mount();
    expect(result.current.blockedReason).toBe("Describe the problem first.");
    act(() => result.current.send());
    expect(create).not.toHaveBeenCalled();
  });

  it("makes the bundle, uploads it with consent, and reads back a reference", async () => {
    const { result } = mount();
    await describe_(result);
    act(() => result.current.send());
    expect(result.current.phase).toEqual({ kind: "sending" });
    await waitFor(() =>
      expect(result.current.phase).toEqual({
        kind: "sent",
        reference: "R-Zk3Lm9Qx",
      }),
    );
    expect(submit).toHaveBeenCalledWith({
      filename: BUNDLE.filename,
      description: DESCRIPTION,
      consent: true,
    });
  });

  it("builds the bundle once when the preview came first", async () => {
    const { result } = mount();
    await describe_(result);
    act(() => result.current.togglePreview());
    expect(result.current.preview).toEqual({ kind: "loading" });
    await waitFor(() => expect(result.current.preview.kind).toBe("ready"));
    act(() => result.current.send());
    await waitFor(() => expect(result.current.phase.kind).toBe("sent"));
    expect(create).toHaveBeenCalledOnce();
  });

  it("closes the preview on a second press", async () => {
    const { result } = mount();
    act(() => result.current.togglePreview());
    await waitFor(() => expect(result.current.preview.kind).toBe("ready"));
    act(() => result.current.togglePreview());
    expect(result.current.preview).toEqual({ kind: "closed" });
  });

  it("says why the preview failed", async () => {
    create.mockRejectedValue(new Error("disk full"));
    const { result } = mount();
    act(() => result.current.togglePreview());
    await waitFor(() => expect(result.current.preview.kind).toBe("failed"));
  });

  it("keeps a report offline on this computer and sends it when the connection returns", async () => {
    setOnline(false);
    const { result } = mount();
    await describe_(result);
    act(() => result.current.send());
    await waitFor(() =>
      expect(result.current.phase).toEqual({ kind: "queued" }),
    );
    expect(submit).not.toHaveBeenCalled();
    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() =>
      expect(result.current.phase).toEqual({
        kind: "sent",
        reference: "R-Zk3Lm9Qx",
      }),
    );
    expect(submit).toHaveBeenCalledWith({
      filename: BUNDLE.filename,
      description: DESCRIPTION,
      consent: true,
    });
  });

  it("keeps a queued report when the sheet closes", async () => {
    setOnline(false);
    const { result, rerender } = mount();
    await describe_(result);
    act(() => result.current.send());
    await waitFor(() => expect(result.current.phase.kind).toBe("queued"));
    rerender({ open: false });
    expect(result.current.phase.kind).toBe("queued");
  });

  it("says a failed send in plain words and lets the person retry", async () => {
    submit.mockRejectedValueOnce(new Error("report relay unavailable"));
    const { result } = mount();
    await describe_(result);
    act(() => result.current.send());
    await waitFor(() => expect(result.current.phase.kind).toBe("failed"));
    act(() => result.current.send());
    await waitFor(() => expect(result.current.phase.kind).toBe("sent"));
    expect(create).toHaveBeenCalledOnce();
  });

  it("saves the bundle here and points at support when no relay is configured", async () => {
    meta.mockResolvedValue({
      report_available: false,
      support_url: BUNDLE.support_url,
      privacy_url: "",
      repository_url: "",
      release_manifest_url: null,
    });
    const { result } = mount();
    await describe_(result);
    act(() => result.current.send());
    await waitFor(() => expect(result.current.phase.kind).toBe("saved"));
    expect(result.current.phase).toMatchObject({
      path: BUNDLE.path,
      supportHref: expect.stringContaining("template=bug_report.yml"),
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("starts clean when the sheet closes and opens again", async () => {
    const { result, rerender } = mount();
    await describe_(result);
    act(() => result.current.send());
    await waitFor(() => expect(result.current.phase.kind).toBe("sent"));
    rerender({ open: false });
    await waitFor(() => expect(result.current.description).toBe(""));
    expect(result.current.phase).toEqual({ kind: "editing" });
  });
});
