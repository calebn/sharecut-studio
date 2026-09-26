import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiagnosticsBundle,
  type DiagnosticsBundleResult,
  fetchDiagnosticsMeta,
  fetchDiagnosticsReportStatus,
  submitDiagnosticsReport,
} from "../api";
import { expectNoA11yViolations } from "../test/a11y";
import { HelpDialog } from "./HelpDialog";

vi.mock("../api", () => ({
  createDiagnosticsBundle: vi.fn(),
  fetchDiagnosticsMeta: vi.fn(),
  fetchDiagnosticsReportStatus: vi.fn(),
  submitDiagnosticsReport: vi.fn(),
}));

const createMock = vi.mocked(createDiagnosticsBundle);
const submitMock = vi.mocked(submitDiagnosticsReport);
const metaMock = vi.mocked(fetchDiagnosticsMeta);

describe("HelpDialog", () => {
  beforeEach(() => {
    createMock.mockReset();
    metaMock.mockReset();
    submitMock.mockReset();
    vi.mocked(fetchDiagnosticsReportStatus).mockReset();
    vi.mocked(fetchDiagnosticsReportStatus).mockResolvedValue({
      status: "queued",
      issue_url: null,
    });
    submitMock.mockResolvedValue({
      status: "queued",
      status_url: "https://relay.example.test/api/reports/abc",
    });
    metaMock.mockResolvedValue({
      support_url: "https://support.example.test",
      report_available: true,
      privacy_url: "https://privacy.example.test",
      repository_url: "https://code.example.test/sharecut",
      release_manifest_url: "https://downloads.example.test/latest.json",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a bundle, shows the path, and links to support", async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue({
      path: "/Users/ada/Downloads/sharecut-diagnostics-20260919T120000Z-ab12cd.zip",
      filename: "sharecut-diagnostics-20260919T120000Z-ab12cd.zip",
      support_url: "https://support.example.test",
      size_bytes: 12,
      files: ["report.json", "README.txt"],
      app_version: "1.0",
      created_at: "2026-09-26T00:00:00Z",
    });
    const { container } = render(<HelpDialog open onClose={() => undefined} />);
    await waitFor(() => {
      expect(metaMock).toHaveBeenCalled();
    });
    expect(screen.getByRole("link", { name: "Open support" })).toHaveAttribute(
      "href",
      "https://support.example.test",
    );
    await expectNoA11yViolations(container);
    const create = screen.getByRole("button", {
      name: "Create diagnostics bundle",
    });
    expect(create).not.toHaveAttribute("aria-busy");
    await user.click(create);
    expect(await screen.findByText(/Saved to/)).toHaveTextContent(
      "sharecut-diagnostics-20260919T120000Z-ab12cd.zip",
    );
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText(/reveal the zip/i)).toBeInTheDocument();
    expect(screen.getByText(/report.json, README.txt/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Submit report" }),
    ).toBeDisabled();
    await user.type(
      screen.getByLabelText("Describe the problem"),
      "Opening an episode fails",
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({ consent: true }),
    );
    expect(
      await screen.findByRole("link", { name: "Check publication status" }),
    ).toHaveAttribute("href", "https://relay.example.test/api/reports/abc");
    expect(createMock).toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("sets aria-busy on the create button while the bundle is in flight", async () => {
    const user = userEvent.setup();
    let finish: (value: DiagnosticsBundleResult) => void = () => undefined;
    createMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<HelpDialog open onClose={() => undefined} />);
    const create = screen.getByRole("button", {
      name: "Create diagnostics bundle",
    });
    await user.click(create);
    expect(screen.getByRole("button", { name: "Creating…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    finish({
      path: "/tmp/sharecut-diagnostics-20260919T120000Z-ab12cd.zip",
      filename: "sharecut-diagnostics-20260919T120000Z-ab12cd.zip",
      support_url: "https://support.example.test",
      size_bytes: 12,
      files: ["report.json", "README.txt"],
      app_version: "1.0",
      created_at: "2026-09-26T00:00:00Z",
    });
    expect(await screen.findByText(/Saved to/)).toBeInTheDocument();
  });

  it("shows an error when bundle creation fails", async () => {
    const user = userEvent.setup();
    metaMock.mockRejectedValue(new Error("offline"));
    createMock.mockRejectedValue(new Error("disk full"));
    render(<HelpDialog open onClose={() => undefined} />);
    await user.click(
      screen.getByRole("button", { name: "Create diagnostics bundle" }),
    );
    expect(await screen.findByText("disk full")).toBeInTheDocument();
  });
});

describe("HelpDialog fallback", () => {
  it("prefills a GitHub issue and hides relay submission when unconfigured", async () => {
    const user = userEvent.setup();
    metaMock.mockResolvedValue({
      support_url: "https://github.com/calebn/sharecut-studio/issues",
      report_available: false,
      privacy_url: "https://example.test/privacy",
      repository_url: "https://github.com/calebn/sharecut-studio",
      release_manifest_url: null,
    });
    createMock.mockResolvedValue({
      path: "/tmp/sharecut-diagnostics-20260919T120000Z-ab12cd.zip",
      filename: "sharecut-diagnostics-20260919T120000Z-ab12cd.zip",
      support_url: "https://github.com/calebn/sharecut-studio/issues",
      size_bytes: 12,
      files: ["report.json", "README.txt"],
      app_version: "1.0",
      created_at: "2026-09-26T00:00:00Z",
    });
    render(<HelpDialog open onClose={() => undefined} />);
    await user.click(
      screen.getByRole("button", { name: "Create diagnostics bundle" }),
    );
    fireEvent.change(screen.getByLabelText("Describe the problem"), {
      target: { value: "Episode cannot open" },
    });
    expect(
      screen.queryByRole("button", { name: "Submit report" }),
    ).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open support" });
    await waitFor(() =>
      expect(link.getAttribute("href")).toContain(
        "what-happened=Episode%20cannot%20open",
      ),
    );
    expect(link.getAttribute("href")).toContain("version=1.0");
  });
});
