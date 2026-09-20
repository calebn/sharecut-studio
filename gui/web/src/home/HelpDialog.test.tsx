import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiagnosticsBundle,
  type DiagnosticsBundleResult,
  fetchDiagnosticsMeta,
} from "../api";
import { expectNoA11yViolations } from "../test/a11y";
import { HelpDialog } from "./HelpDialog";

vi.mock("../api", () => ({
  createDiagnosticsBundle: vi.fn(),
  fetchDiagnosticsMeta: vi.fn(),
}));

const createMock = vi.mocked(createDiagnosticsBundle);
const metaMock = vi.mocked(fetchDiagnosticsMeta);

describe("HelpDialog", () => {
  beforeEach(() => {
    createMock.mockReset();
    metaMock.mockReset();
    metaMock.mockResolvedValue({
      support_url: "https://support.example.test",
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
    expect(screen.getByText(/Reveal the zip/)).toBeInTheDocument();
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
