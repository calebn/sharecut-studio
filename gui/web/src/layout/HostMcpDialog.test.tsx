import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { HostMcpDialog } from "./HostMcpDialog";
import { localHostMcpUrl, mcpClientSnippet } from "./hostMcp";

describe("localHostMcpUrl", () => {
  it("always copies loopback and maps Vite 5173 to 8765", () => {
    expect(
      localHostMcpUrl({
        protocol: "http:",
        hostname: "localhost",
        port: "8765",
      }),
    ).toBe("http://127.0.0.1:8765/mcp");
    expect(
      localHostMcpUrl({
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "5173",
      }),
    ).toBe("http://127.0.0.1:8765/mcp");
    expect(
      localHostMcpUrl({
        protocol: "http:",
        hostname: "192.168.1.9",
        port: "8765",
      }),
    ).toBe("http://127.0.0.1:8765/mcp");
    expect(
      localHostMcpUrl({
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "54321",
      }),
    ).toBe("http://127.0.0.1:54321/mcp");
  });
});

describe("HostMcpDialog", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("shows the URL, snippet, and is axe-clean", async () => {
    const { container } = render(
      <HostMcpDialog open onClose={() => undefined} hasProject />,
    );
    expect(
      await screen.findByRole("dialog", { name: "Connect agent" }),
    ).toBeTruthy();
    const url = localHostMcpUrl();
    expect(screen.getByLabelText("MCP URL")).toHaveValue(url);
    expect(screen.getByText(/Keep Sharecut Studio running/)).toBeTruthy();
    expect(screen.getByLabelText("Cursor snippet")).toHaveValue(
      mcpClientSnippet(url),
    );
    await expectNoA11yViolations(container);
  });

  it("copies the MCP URL and announces in the live region", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<HostMcpDialog open onClose={() => undefined} hasProject />);
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(localHostMcpUrl());
    });
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByText("Copied MCP URL")).toBeTruthy();
  });

  it("copies the snippet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<HostMcpDialog open onClose={() => undefined} hasProject />);
    fireEvent.click(screen.getByRole("button", { name: "Copy snippet" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        mcpClientSnippet(localHostMcpUrl()),
      );
    });
    expect(screen.getByText("Copied client snippet")).toBeTruthy();
  });

  it("surfaces clipboard failure in the live region", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi
          .fn()
          .mockRejectedValue(new Error("Clipboard unavailable")),
      },
    });
    render(<HostMcpDialog open onClose={() => undefined} hasProject />);
    fireEvent.click(screen.getByRole("button", { name: "Copy snippet" }));
    expect(await screen.findByText("Clipboard unavailable")).toBeTruthy();
  });

  it("clears copy status when the dialog is closed", async () => {
    const { rerender } = render(
      <HostMcpDialog open onClose={() => undefined} hasProject />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    expect(await screen.findByText("Copied MCP URL")).toBeTruthy();
    rerender(
      <HostMcpDialog open={false} onClose={() => undefined} hasProject />,
    );
    rerender(<HostMcpDialog open onClose={() => undefined} hasProject />);
    expect(screen.queryByText("Copied MCP URL")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy URL" })).toBeTruthy();
  });

  it("warns when no episode is open", async () => {
    const { container } = render(
      <HostMcpDialog open onClose={() => undefined} hasProject={false} />,
    );
    expect(await screen.findByText(/Open an episode first/)).toBeTruthy();
    await expectNoA11yViolations(container);
  });
});
