import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppSheets, type AppSheetsProps } from "./AppSheets";

vi.mock("../../api", () => ({
  createDiagnosticsBundle: vi.fn(),
  fetchDiagnosticsMeta: vi.fn(async () => ({
    report_available: false,
    support_url: null,
  })),
  submitDiagnosticsReport: vi.fn(),
}));

function setup(props: Partial<AppSheetsProps> = {}) {
  const handlers = {
    onCloseHelp: vi.fn(),
    onCloseAgent: vi.fn(),
    onCloseSettings: vi.fn(),
    onShortcuts: vi.fn(),
    onModels: vi.fn(),
    onOpenRecent: vi.fn(),
  };
  const view = render(
    <AppSheets
      helpOpen={false}
      agentOpen={false}
      settingsOpen={false}
      hasProject
      agentName={null}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...view, user: userEvent.setup() };
}

describe("AppSheets", () => {
  it("renders nothing until one is asked for", () => {
    setup();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens Help and returns to its menu after Report a problem and a close", async () => {
    const { user, onCloseHelp } = setup({ helpOpen: true });
    await user.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(
      screen.getByRole("dialog", { name: "Report a problem" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onCloseHelp).toHaveBeenCalledOnce();
  });

  it("opens Connect agent with the host's loopback URL", () => {
    setup({ agentOpen: true, agentName: "Claude" });
    expect(screen.getByRole("dialog", { name: "Connect agent" })).toBeVisible();
    expect(screen.getByLabelText<HTMLTextAreaElement>("MCP URL").value).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/mcp$/,
    );
    expect(screen.getByText("Connected: Claude")).toBeInTheDocument();
  });

  it("shows the project's folder under Settings only while an episode is open", async () => {
    const { user, rerender, ...rest } = setup({
      settingsOpen: true,
      projectFolder: "/ws/ep",
    });
    expect(
      screen.getByRole("button", { name: /Project settings/ }),
    ).toBeInTheDocument();
    rerender(
      <AppSheets
        helpOpen={false}
        agentOpen={false}
        settingsOpen
        hasProject={false}
        agentName={null}
        onCloseHelp={rest.onCloseHelp}
        onCloseAgent={rest.onCloseAgent}
        onCloseSettings={rest.onCloseSettings}
        onModels={rest.onModels}
        onOpenRecent={rest.onOpenRecent}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Project settings/ }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Models/ }));
    expect(rest.onModels).toHaveBeenCalledOnce();
  });
});
