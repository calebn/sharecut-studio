import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiagnosticsBundle,
  type DiagnosticsBundleResult,
  fetchDiagnosticsMeta,
  fetchDiagnosticsReportStatus,
  submitDiagnosticsReport,
} from "../api";
import { expectNoA11yViolations } from "../test/a11y";
import { waitForDialogFocus } from "../test/dialogFocus";
import { HelpDialog } from "./HelpDialog";
import { CREATE_LABEL, REPORT_TITLE } from "./HelpDialogView";

vi.mock("../api", () => ({
  createDiagnosticsBundle: vi.fn(),
  fetchDiagnosticsMeta: vi.fn(),
  fetchDiagnosticsReportStatus: vi.fn(),
  submitDiagnosticsReport: vi.fn(),
}));

const createMock = vi.mocked(createDiagnosticsBundle);
const submitMock = vi.mocked(submitDiagnosticsReport);
const metaMock = vi.mocked(fetchDiagnosticsMeta);

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

async function renderOpenHelp() {
  const view = render(
    <HelpDialog open initialStep="report" onClose={() => undefined} />,
  );
  await waitForDialogFocus();
  return view;
}

const bundleResult: DiagnosticsBundleResult = {
  path: "/Users/ada/Downloads/sharecut-diagnostics-20260919T120000Z-ab12cd.zip",
  filename: "sharecut-diagnostics-20260919T120000Z-ab12cd.zip",
  support_url: "https://support.example.test",
  size_bytes: 12,
  files: ["report.json"],
  app_version: "1.0",
  created_at: "2026-09-26T00:00:00Z",
};

describe("HelpDialog", () => {
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
    const { baseElement: container } = await renderOpenHelp();
    await waitFor(() => {
      expect(metaMock).toHaveBeenCalled();
    });
    expect(screen.getByRole("link", { name: "Open support" })).toHaveAttribute(
      "href",
      "https://support.example.test",
    );
    await expectNoA11yViolations(container);
    const create = screen.getByRole("button", {
      name: CREATE_LABEL,
    });
    expect(create).not.toHaveAttribute("aria-busy");
    await user.click(create);
    expect(await screen.findByText(/Saved to/)).toHaveTextContent(
      "sharecut-diagnostics-20260919T120000Z-ab12cd.zip",
    );
    expect(
      screen.getByText(/Saved to/).closest('[role="status"]'),
    ).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText(/reveal the zip/i)).toBeInTheDocument();
    expect(screen.getByText("Preview what's included")).toBeInTheDocument();
    expect(screen.getByText("report.json")).toBeInTheDocument();
    expect(screen.getByText("README.txt")).toBeInTheDocument();
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
    await renderOpenHelp();
    const create = screen.getByRole("button", {
      name: CREATE_LABEL,
    });
    await user.click(create);
    expect(screen.getByRole("button", { name: "Exporting…" })).toHaveAttribute(
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
    await renderOpenHelp();
    await user.click(screen.getByRole("button", { name: CREATE_LABEL }));
    expect(await screen.findByText("disk full")).toBeInTheDocument();
  });

  it("submits one bundle once and resets publication for a new bundle", async () => {
    const user = userEvent.setup();
    const result = (name: string): DiagnosticsBundleResult => ({
      path: `/tmp/${name}`,
      filename: name,
      support_url: "https://support.example.test",
      size_bytes: 12,
      files: ["report.json", "README.txt"],
      app_version: "1.0",
      created_at: "2026-09-26T00:00:00Z",
    });
    createMock
      .mockResolvedValueOnce(result("report-a.zip"))
      .mockResolvedValueOnce(result("report-b.zip"));
    submitMock
      .mockResolvedValueOnce({
        status: "queued",
        status_url: "https://relay.test/api/reports/a",
      })
      .mockResolvedValueOnce({
        status: "queued",
        status_url: "https://relay.test/api/reports/b",
      });
    vi.mocked(fetchDiagnosticsReportStatus).mockImplementation(async (url) =>
      url.endsWith("/a")
        ? {
            status: "published",
            issue_url: "https://github.com/example/issues/1",
          }
        : { status: "queued", issue_url: null },
    );
    await renderOpenHelp();
    await user.click(screen.getByRole("button", { name: CREATE_LABEL }));
    await screen.findByText(/report-a.zip/);
    await user.type(
      screen.getByLabelText("Describe the problem"),
      "Episode cannot open",
    );
    await user.click(screen.getByRole("checkbox"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Submit report" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(
      await screen.findByRole("link", { name: "Open published issue" }),
    ).toHaveAttribute("href", "https://github.com/example/issues/1");
    expect(screen.getByText(/Report published/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Report queued for publication/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Submit report" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(submitMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: CREATE_LABEL }));
    await screen.findByText(/report-b.zip/);
    expect(
      screen.queryByRole("link", { name: "Open published issue" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Submit report" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("link", { name: "Check publication status" }),
    ).toHaveAttribute("href", "https://relay.test/api/reports/b");
    expect(vi.mocked(fetchDiagnosticsReportStatus)).toHaveBeenCalledWith(
      "https://relay.test/api/reports/b",
    );
    expect(
      screen.queryByRole("link", { name: "Open published issue" }),
    ).not.toBeInTheDocument();
  });

  it("ignores a submit completing after close and a new bundle", async () => {
    const user = userEvent.setup();
    const result = (name: string): DiagnosticsBundleResult => ({
      path: `/tmp/${name}`,
      filename: name,
      support_url: "https://support.example.test",
      size_bytes: 12,
      files: ["report.json", "README.txt"],
      app_version: "1.0",
      created_at: "2026-09-26T00:00:00Z",
    });
    createMock
      .mockResolvedValueOnce(result("report-a.zip"))
      .mockResolvedValueOnce(result("report-b.zip"));
    let finishA: (value: { status: string; status_url: string }) => void = () =>
      undefined;
    submitMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishA = resolve;
          }),
      )
      .mockResolvedValueOnce({
        status: "queued",
        status_url: "https://relay.test/api/reports/b",
      });
    const { rerender } = await renderOpenHelp();
    await user.click(screen.getByRole("button", { name: CREATE_LABEL }));
    await screen.findByText(/report-a.zip/);
    await user.type(
      screen.getByLabelText("Describe the problem"),
      "Episode cannot open",
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(submitMock).toHaveBeenCalledTimes(1);
    rerender(<HelpDialog open={false} onClose={() => undefined} />);
    rerender(
      <HelpDialog open initialStep="report" onClose={() => undefined} />,
    );
    await waitForDialogFocus();
    await user.click(screen.getByRole("button", { name: CREATE_LABEL }));
    await screen.findByText(/report-b.zip/);
    await user.type(
      screen.getByLabelText("Describe the problem"),
      "New bundle cannot open",
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(
      await screen.findByRole("link", { name: "Check publication status" }),
    ).toHaveAttribute("href", "https://relay.test/api/reports/b");
    finishA({
      status: "queued",
      status_url: "https://relay.test/api/reports/a",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Check publication status" }),
      ).toHaveAttribute("href", "https://relay.test/api/reports/b"),
    );
    expect(submitMock).toHaveBeenCalledTimes(2);
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
    await renderOpenHelp();
    await user.click(screen.getByRole("button", { name: CREATE_LABEL }));
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

  it("opens on the three-row menu and steps into the report and back", async () => {
    const user = userEvent.setup();
    const onShortcuts = vi.fn();
    const onGuides = vi.fn();
    render(
      <HelpDialog
        open
        onClose={() => undefined}
        onOpenShortcuts={onShortcuts}
        onOpenGuides={onGuides}
      />,
    );
    await waitForDialogFocus();
    const rows = within(screen.getByRole("list", { name: "Help" }))
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(rows).toEqual([
      "Shortcuts and gestures",
      "Report a problem",
      "Guides",
    ]);
    expect(screen.queryByRole("button", { name: CREATE_LABEL })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: /Shortcuts and gestures/ }),
    );
    expect(onShortcuts).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: /Guides/ }));
    expect(onGuides).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: /Report a problem/ }));
    expect(
      screen.getByRole("dialog", { name: REPORT_TITLE }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: CREATE_LABEL }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "Help" })).toBeInTheDocument();
  });

  it("puts Back beside the report step's title and announces each step change", async () => {
    const user = userEvent.setup();
    render(<HelpDialog open onClose={() => undefined} />);
    await waitForDialogFocus();
    const announced = () =>
      screen
        .getAllByRole("status")
        .map((region) => region.textContent)
        .join("");
    expect(announced()).toBe("");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Report a problem/ }));
    const title = screen.getByRole("heading", { name: REPORT_TITLE });
    const back = screen.getByRole("button", { name: "Back" });
    expect(back.parentElement).toBe(title.parentElement);
    expect(back.compareDocumentPosition(title)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(announced()).toBe(REPORT_TITLE);
    await user.click(back);
    expect(screen.getByRole("dialog", { name: "Help" })).toBeInTheDocument();
    expect(announced()).toBe("Help");
  });

  it("reopens on the menu with no stale report step on the first commit", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <HelpDialog open initialStep="menu" onClose={() => undefined} />,
    );
    await waitForDialogFocus();
    await user.click(screen.getByRole("button", { name: /Report a problem/ }));
    expect(
      screen.getByRole("button", { name: CREATE_LABEL }),
    ).toBeInTheDocument();
    rerender(
      <HelpDialog open={false} initialStep="menu" onClose={() => undefined} />,
    );
    rerender(<HelpDialog open initialStep="menu" onClose={() => undefined} />);
    expect(screen.queryByRole("button", { name: CREATE_LABEL })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Help" })).toBeInTheDocument();
    await waitForDialogFocus();
    expect(
      screen
        .getByRole("dialog", { name: "Help" })
        .contains(document.activeElement),
    ).toBe(true);
    expect(document.activeElement).not.toHaveAccessibleName(CREATE_LABEL);
  });

  it("keeps the step and description when initialStep changes while open", async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue({
      path: "/tmp/a.zip",
      filename: "a.zip",
      support_url: "https://support.example.test",
      size_bytes: 12,
      files: ["report.json"],
      app_version: "1.0",
      created_at: "2026-09-26T00:00:00Z",
    });
    const { rerender } = render(
      <HelpDialog open initialStep="report" onClose={() => undefined} />,
    );
    await waitForDialogFocus();
    await user.click(screen.getByRole("button", { name: CREATE_LABEL }));
    await user.type(
      await screen.findByLabelText("Describe the problem"),
      "Keeps this text",
    );
    rerender(<HelpDialog open initialStep="menu" onClose={() => undefined} />);
    expect(screen.getByLabelText("Describe the problem")).toHaveValue(
      "Keeps this text",
    );
    expect(metaMock).toHaveBeenCalledTimes(1);
  });

  it("moves focus to Create on the report step and back to the row on Back", async () => {
    const user = userEvent.setup();
    render(<HelpDialog open initialStep="menu" onClose={() => undefined} />);
    await waitForDialogFocus();
    await user.click(screen.getByRole("button", { name: /Report a problem/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: CREATE_LABEL })).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Report a problem/ }),
      ).toHaveFocus(),
    );
  });

  it("closes the whole sheet on Escape from the report step", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<HelpDialog open initialStep="report" onClose={onClose} />);
    await waitForDialogFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  describe.each([
    ["Escape", false, () => userEvent.keyboard("{Escape}")],
    [
      "Escape on an anchored popover",
      true,
      () => userEvent.keyboard("{Escape}"),
    ],
    [
      "an outside press on an anchored popover",
      true,
      () => userEvent.click(document.body),
    ],
  ])("dismissing with %s", (_name, anchored, dismiss) => {
    it("keeps a typed description across closing and reopening", async () => {
      createMock.mockResolvedValue(bundleResult);
      const user = userEvent.setup();
      function Harness() {
        const [open, setOpen] = useState(true);
        const anchor = useRef<HTMLButtonElement>(null);
        return (
          <>
            <button type="button" ref={anchor} onClick={() => setOpen(true)}>
              Open help
            </button>
            <HelpDialog
              open={open}
              anchorRef={anchored ? anchor : undefined}
              initialStep="menu"
              onClose={() => setOpen(false)}
            />
          </>
        );
      }
      render(<Harness />);
      await waitForDialogFocus();
      const toReport = async () => {
        await user.click(
          await screen.findByRole("button", { name: /Report a problem/ }),
        );
        await user.click(screen.getByRole("button", { name: CREATE_LABEL }));
      };
      await toReport();
      await user.type(
        await screen.findByLabelText("Describe the problem"),
        "Opening an episode fails",
      );
      await dismiss();
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: REPORT_TITLE })).toBeNull(),
      );
      await user.click(screen.getByRole("button", { name: "Open help" }));
      await toReport();
      expect(await screen.findByLabelText("Describe the problem")).toHaveValue(
        "Opening an episode fails",
      );
    });
  });

  it("clears the draft when the dialog closes while the accepted report is still in flight", async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue(bundleResult);
    let accept: (value: { status: string; status_url: string }) => void = () =>
      undefined;
    submitMock.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    const { rerender } = render(
      <HelpDialog open initialStep="report" onClose={() => undefined} />,
    );
    await waitForDialogFocus();
    await user.click(screen.getByRole("button", { name: CREATE_LABEL }));
    await user.type(
      await screen.findByLabelText("Describe the problem"),
      "Opening an episode fails",
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(submitMock).toHaveBeenCalledOnce());
    rerender(
      <HelpDialog
        open={false}
        initialStep="report"
        onClose={() => undefined}
      />,
    );
    await act(async () => {
      accept({ status: "queued", status_url: "https://relay.example.test/r" });
    });
    rerender(
      <HelpDialog open initialStep="report" onClose={() => undefined} />,
    );
    await user.click(await screen.findByRole("button", { name: CREATE_LABEL }));
    expect(await screen.findByLabelText("Describe the problem")).toHaveValue(
      "",
    );
  });

  it("focuses Export diagnostics when it opens straight on the report step", async () => {
    render(<HelpDialog open initialStep="report" onClose={() => undefined} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: CREATE_LABEL })).toHaveFocus(),
    );
  });

  it("clears the description after a successful submit once the dialog is reopened", async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue(bundleResult);
    const { rerender } = render(
      <HelpDialog open initialStep="report" onClose={() => undefined} />,
    );
    await waitForDialogFocus();
    await user.click(screen.getByRole("button", { name: CREATE_LABEL }));
    await user.type(
      await screen.findByLabelText("Describe the problem"),
      "Opening an episode fails",
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(submitMock).toHaveBeenCalledOnce());
    rerender(
      <HelpDialog
        open={false}
        initialStep="report"
        onClose={() => undefined}
      />,
    );
    rerender(
      <HelpDialog open initialStep="report" onClose={() => undefined} />,
    );
    await user.click(await screen.findByRole("button", { name: CREATE_LABEL }));
    expect(await screen.findByLabelText("Describe the problem")).toHaveValue(
      "",
    );
  });

  it("puts focus on the first row when it opens on the menu step", async () => {
    render(<HelpDialog open initialStep="menu" onClose={() => undefined} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Shortcuts and gestures/ }),
      ).toHaveFocus(),
    );
  });
});
