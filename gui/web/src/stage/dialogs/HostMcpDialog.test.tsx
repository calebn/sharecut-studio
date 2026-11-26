import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { HostMcpDialog } from "./HostMcpDialog";
import {
  COPY_FAILED_MESSAGE,
  localHostMcpUrl,
  mcpClientSnippet,
} from "./hostMcp";

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
    const { baseElement: container } = render(
      <HostMcpDialog open onClose={() => undefined} hasProject />,
    );
    expect(
      await screen.findByRole("dialog", { name: "Connect agent" }),
    ).toBeTruthy();
    const url = localHostMcpUrl();
    expect(screen.getByLabelText("MCP URL")).toHaveValue(url);
    expect(screen.getByText(/Keep ShareCut Studio running/)).toBeTruthy();
    expect(screen.getByLabelText("Cursor snippet")).toHaveValue(
      mcpClientSnippet(url),
    );
    await expectNoA11yViolations(container);
  });

  it("uses a fixed preview URL for both fields when supplied", () => {
    const mcpUrl = "http://127.0.0.1:8765/mcp";
    render(
      <HostMcpDialog
        open
        onClose={() => undefined}
        hasProject
        mcpUrl={mcpUrl}
      />,
    );
    expect(screen.getByLabelText("MCP URL")).toHaveValue(mcpUrl);
    expect(screen.getByLabelText("Cursor snippet")).toHaveValue(
      mcpClientSnippet(mcpUrl),
    );
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

  it.each([
    ["a denied write", () => new DOMException("denied", "NotAllowedError")],
    ["a plain error", () => new Error("Clipboard unavailable")],
    ["a non-Error value", () => "nope"],
  ])("says one plain thing when %s fails", async (_name, failure) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(failure()) },
    });
    render(<HostMcpDialog open onClose={() => undefined} hasProject />);
    fireEvent.click(screen.getByRole("button", { name: "Copy snippet" }));
    expect(await screen.findByText(COPY_FAILED_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(/denied|unavailable|nope/i)).toBeNull();
    expect(COPY_FAILED_MESSAGE).not.toMatch(/ctrl|cmd/i);
  });

  it("says the same thing when there is no clipboard at all", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    render(<HostMcpDialog open onClose={() => undefined} hasProject />);
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    expect(await screen.findByText(COPY_FAILED_MESSAGE)).toBeTruthy();
    expect(screen.queryByText("Clipboard unavailable")).toBeNull();
  });

  it("puts initial focus on Copy URL", async () => {
    render(<HostMcpDialog open onClose={() => undefined} hasProject />);
    const copyUrl = screen.getByRole("button", { name: "Copy URL" });
    await waitFor(() => expect(document.activeElement).toBe(copyUrl));
  });

  it.each([
    ["MCP URL", () => localHostMcpUrl()],
    ["Cursor snippet", () => mcpClientSnippet(localHostMcpUrl())],
  ])("selects the whole %s on focus", (label, value) => {
    render(<HostMcpDialog open onClose={() => undefined} hasProject />);
    const field = screen.getByLabelText(label) as
      | HTMLInputElement
      | HTMLTextAreaElement;
    field.setSelectionRange(0, 0);
    fireEvent.focus(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(value().length);
  });

  describe("status timer", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    async function click(name: string) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name }));
      });
    }

    it.each([
      ["Copy URL", "Copied MCP URL"],
      ["Copy snippet", "Copied client snippet"],
    ])(
      "clears the label and the status together after 2 s (%s)",
      async (name, text) => {
        render(<HostMcpDialog open onClose={() => undefined} hasProject />);
        await click(name);
        expect(screen.getByText(text)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
        act(() => {
          vi.advanceTimersByTime(1999);
        });
        expect(screen.getByText(text)).toBeTruthy();
        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(screen.queryByText(text)).toBeNull();
        expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
        expect(screen.getByRole("button", { name })).toBeTruthy();
      },
    );

    it("restarts the 2 s window on a second copy", async () => {
      render(<HostMcpDialog open onClose={() => undefined} hasProject />);
      await click("Copy URL");
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      await click("Copy snippet");
      expect(screen.getByText("Copied client snippet")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(screen.getByText("Copied client snippet")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.queryByText("Copied client snippet")).toBeNull();
    });

    it("does not let an old timer clear a copy made after close and reopen", async () => {
      const { rerender } = render(
        <HostMcpDialog open onClose={() => undefined} hasProject />,
      );
      await click("Copy URL");
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      rerender(
        <HostMcpDialog open={false} onClose={() => undefined} hasProject />,
      );
      rerender(<HostMcpDialog open onClose={() => undefined} hasProject />);
      await click("Copy URL");
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText("Copied MCP URL")).toBeTruthy();
    });

    it("keeps a failure message on screen", async () => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn().mockRejectedValue(new Error("x")) },
      });
      render(<HostMcpDialog open onClose={() => undefined} hasProject />);
      await click("Copy URL");
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByText(COPY_FAILED_MESSAGE)).toBeTruthy();
    });
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

  it.each([true, false])(
    "ignores a copy settled after close and reopen (success: %s)",
    async (succeeds) => {
      const pending: { resolve: () => void; reject: (error: Error) => void }[] =
        [];
      const writeText = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve, reject) =>
              pending.push({ resolve, reject }),
            ),
        )
        .mockResolvedValueOnce(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      const { rerender } = render(
        <HostMcpDialog open onClose={() => undefined} hasProject />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
      await waitFor(() => expect(pending).toHaveLength(1));
      rerender(
        <HostMcpDialog open={false} onClose={() => undefined} hasProject />,
      );
      rerender(<HostMcpDialog open onClose={() => undefined} hasProject />);
      await act(async () => {
        if (succeeds) pending[0]!.resolve();
        else pending[0]!.reject(new Error("Old copy failed"));
      });
      expect(screen.queryByText("Copied MCP URL")).toBeNull();
      expect(screen.queryByText("Old copy failed")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
      expect(await screen.findByText("Copied MCP URL")).toBeVisible();
      expect(writeText).toHaveBeenCalledTimes(2);
    },
  );

  it("warns when no episode is open", async () => {
    const { baseElement: container } = render(
      <HostMcpDialog open onClose={() => undefined} hasProject={false} />,
    );
    expect(await screen.findByText(/Open an episode first/)).toBeTruthy();
    await expectNoA11yViolations(container);
  });
});
