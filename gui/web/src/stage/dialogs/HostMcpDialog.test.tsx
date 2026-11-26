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

  it.each([
    ["MCP URL", () => localHostMcpUrl()],
    ["Cursor snippet", () => mcpClientSnippet(localHostMcpUrl())],
  ])("selects the whole %s again on click", (label, value) => {
    render(<HostMcpDialog open onClose={() => undefined} hasProject />);
    const field = screen.getByLabelText(label) as
      | HTMLInputElement
      | HTMLTextAreaElement;
    field.setSelectionRange(2, 2);
    fireEvent.click(field);
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

    it("drops the Copied label and its timer when a later copy fails", async () => {
      const writeText = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("denied"));
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      render(<HostMcpDialog open onClose={() => undefined} hasProject />);
      await click("Copy URL");
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
      await click("Copy snippet");
      expect(screen.getByText(COPY_FAILED_MESSAGE)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
      expect(screen.queryByText("Copied MCP URL")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(screen.getByText(COPY_FAILED_MESSAGE)).toBeTruthy();
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

  describe("announcement structure (roles and DOM only; no screen reader)", () => {
    function statusNode(): HTMLElement {
      const node = document.querySelector<HTMLElement>(".share-dialog-status");
      if (!node) throw new Error("status element is not mounted");
      return node;
    }

    function useClipboard(writeText: () => Promise<void>) {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn(writeText) },
      });
    }

    it("mounts one empty polite status before any click", () => {
      render(<HostMcpDialog open onClose={() => undefined} hasProject />);
      const node = statusNode();
      expect(node.getAttribute("role")).toBe("status");
      expect(node.getAttribute("aria-live")).toBe("polite");
      expect(node.getAttribute("aria-atomic")).toBe("true");
      expect(node.textContent).toBe("");
      expect(screen.queryAllByRole("alert")).toHaveLength(0);
    });

    it("puts the success text in that same node and no alert", async () => {
      render(<HostMcpDialog open onClose={() => undefined} hasProject />);
      const before = statusNode();
      fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
      await screen.findByText("Copied MCP URL");
      expect(statusNode()).toBe(before);
      expect(before.textContent).toBe("Copied MCP URL");
      expect(screen.queryAllByRole("alert")).toHaveLength(0);
    });

    it("keeps the same status node after the 2 s window", async () => {
      vi.useFakeTimers();
      try {
        render(<HostMcpDialog open onClose={() => undefined} hasProject />);
        const before = statusNode();
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
        });
        expect(before.textContent).toBe("Copied MCP URL");
        act(() => {
          vi.advanceTimersByTime(2000);
        });
        expect(statusNode()).toBe(before);
        expect(before.textContent).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });

    it("announces a failure as exactly one alert outside any live ancestor", async () => {
      useClipboard(() => Promise.reject(new Error("denied")));
      const { baseElement } = render(
        <HostMcpDialog open onClose={() => undefined} hasProject />,
      );
      const copyUrl = screen.getByRole("button", { name: "Copy URL" });
      copyUrl.focus();
      fireEvent.click(copyUrl);
      const alert = await screen.findByRole("alert");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(alert.textContent).toBe(COPY_FAILED_MESSAGE);
      expect(alert.closest("[aria-live]")).toBeNull();
      expect(alert.closest('[role="status"]')).toBeNull();
      expect(statusNode().textContent).toBe("");
      const live = baseElement.querySelectorAll("[role=alert],[aria-live]");
      expect(live).toHaveLength(2);
      expect(live[0]!.contains(live[1]!)).toBe(false);
      expect(live[1]!.contains(live[0]!)).toBe(false);
      expect(document.activeElement).toBe(copyUrl);
      await expectNoA11yViolations(baseElement);
    });

    it("keeps focus on the pressed button after a success", async () => {
      render(<HostMcpDialog open onClose={() => undefined} hasProject />);
      const snippet = screen.getByRole("button", { name: "Copy snippet" });
      snippet.focus();
      fireEvent.click(snippet);
      await screen.findByText("Copied client snippet");
      expect(document.activeElement).toBe(snippet);
    });

    describe("failure lifecycle", () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      async function click(name: string) {
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name }));
        });
      }

      it("keeps the alert past 2 s, removes it on a later success, and re-inserts it on a repeat failure", async () => {
        const writeText = vi
          .fn()
          .mockRejectedValueOnce(new Error("a"))
          .mockRejectedValueOnce(new Error("b"))
          .mockResolvedValueOnce(undefined);
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText },
        });
        render(<HostMcpDialog open onClose={() => undefined} hasProject />);
        await click("Copy URL");
        const first = screen.getByRole("alert");
        act(() => {
          vi.advanceTimersByTime(5000);
        });
        expect(screen.getByRole("alert")).toBe(first);
        await click("Copy URL");
        const second = screen.getByRole("alert");
        expect(second).not.toBe(first);
        expect(second.isConnected).toBe(true);
        expect(first.isConnected).toBe(false);
        expect(second.textContent).toBe(COPY_FAILED_MESSAGE);
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        await click("Copy URL");
        expect(screen.queryAllByRole("alert")).toHaveLength(0);
        expect(statusNode().textContent).toBe("Copied MCP URL");
      });

      it("clears the alert and the status when the dialog closes and reopens", async () => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: vi.fn().mockRejectedValue(new Error("x")) },
        });
        const { rerender } = render(
          <HostMcpDialog open onClose={() => undefined} hasProject />,
        );
        await click("Copy URL");
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        rerender(
          <HostMcpDialog open={false} onClose={() => undefined} hasProject />,
        );
        rerender(<HostMcpDialog open onClose={() => undefined} hasProject />);
        expect(screen.queryAllByRole("alert")).toHaveLength(0);
        expect(statusNode().textContent).toBe("");
      });
    });
  });

  it("warns when no episode is open", async () => {
    const { baseElement: container } = render(
      <HostMcpDialog open onClose={() => undefined} hasProject={false} />,
    );
    expect(await screen.findByText(/Open an episode first/)).toBeTruthy();
    await expectNoA11yViolations(container);
  });
});
