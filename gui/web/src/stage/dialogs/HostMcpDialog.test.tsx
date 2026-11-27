import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHostMcpActivity } from "../../api/hostMcp";
import { expectNoA11yViolations } from "../../test/a11y";
import { ApiError } from "../../utils/apiError";
import { HostMcpDialog } from "./HostMcpDialog";
import {
  ACTIVITY_POLL_MS,
  COPY_FAILED_MESSAGE,
  localHostMcpUrl,
  MCP_SETUP_GUIDE_URL,
  mcpClientSnippet,
  UNAVAILABLE_MESSAGE,
} from "./hostMcp";

vi.mock("../../api/hostMcp", () => ({ fetchHostMcpActivity: vi.fn() }));

const activityMock = vi.mocked(fetchHostMcpActivity);
const NEVER = { mounted: true, last_request_at: null, age_seconds: null };

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
    activityMock.mockReset();
    activityMock.mockResolvedValue(NEVER);
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
    expect(screen.getByLabelText("Connection address")).toHaveValue(url);
    expect(screen.getByText(/Keep ShareCut Studio running/)).toBeTruthy();
    expect(screen.getByLabelText("Configuration (JSON)")).toHaveValue(
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
    expect(screen.getByLabelText("Connection address")).toHaveValue(mcpUrl);
    expect(screen.getByLabelText("Configuration (JSON)")).toHaveValue(
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
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(localHostMcpUrl());
    });
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByText("Copied address")).toBeTruthy();
  });

  it("copies the snippet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<HostMcpDialog open onClose={() => undefined} hasProject />);
    fireEvent.click(screen.getByRole("button", { name: "Copy config" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        mcpClientSnippet(localHostMcpUrl()),
      );
    });
    expect(screen.getByText("Copied config")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Copy config" }));
    expect(await screen.findByText(COPY_FAILED_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(/denied|unavailable|nope/i)).toBeNull();
  });

  it("says the same thing when there is no clipboard at all", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    render(<HostMcpDialog open onClose={() => undefined} hasProject />);
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    expect(await screen.findByText(COPY_FAILED_MESSAGE)).toBeTruthy();
    expect(screen.queryByText("Clipboard unavailable")).toBeNull();
  });

  it("puts initial focus on Copy address", async () => {
    render(<HostMcpDialog open onClose={() => undefined} hasProject />);
    const copyUrl = screen.getByRole("button", { name: "Copy address" });
    await waitFor(() => expect(document.activeElement).toBe(copyUrl));
  });

  it.each([
    ["Connection address", () => localHostMcpUrl()],
    ["Configuration (JSON)", () => mcpClientSnippet(localHostMcpUrl())],
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
    ["Connection address", () => localHostMcpUrl()],
    ["Configuration (JSON)", () => mcpClientSnippet(localHostMcpUrl())],
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
      ["Copy address", "Copied address"],
      ["Copy config", "Copied config"],
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
      await click("Copy address");
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      await click("Copy config");
      expect(screen.getByText("Copied config")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(screen.getByText("Copied config")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.queryByText("Copied config")).toBeNull();
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
      await click("Copy address");
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
      await click("Copy config");
      expect(screen.getByText(COPY_FAILED_MESSAGE)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
      expect(screen.queryByText("Copied address")).toBeNull();
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
      await click("Copy address");
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
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    expect(await screen.findByText("Copied address")).toBeTruthy();
    rerender(
      <HostMcpDialog open={false} onClose={() => undefined} hasProject />,
    );
    rerender(<HostMcpDialog open onClose={() => undefined} hasProject />);
    expect(screen.queryByText("Copied address")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
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
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
      await waitFor(() => expect(pending).toHaveLength(1));
      rerender(
        <HostMcpDialog open={false} onClose={() => undefined} hasProject />,
      );
      rerender(<HostMcpDialog open onClose={() => undefined} hasProject />);
      await act(async () => {
        if (succeeds) pending[0]!.resolve();
        else pending[0]!.reject(new Error("Old copy failed"));
      });
      expect(screen.queryByText("Copied address")).toBeNull();
      expect(screen.queryByText(COPY_FAILED_MESSAGE)).toBeNull();
      expect(screen.queryAllByRole("alert")).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
      expect(await screen.findByText("Copied address")).toBeVisible();
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
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
      await screen.findByText("Copied address");
      expect(statusNode()).toBe(before);
      expect(before.textContent).toBe("Copied address");
      expect(screen.queryAllByRole("alert")).toHaveLength(0);
    });

    it("keeps the same status node after the 2 s window", async () => {
      vi.useFakeTimers();
      try {
        render(<HostMcpDialog open onClose={() => undefined} hasProject />);
        const before = statusNode();
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
        });
        expect(before.textContent).toBe("Copied address");
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
      const copyUrl = screen.getByRole("button", { name: "Copy address" });
      copyUrl.focus();
      fireEvent.click(copyUrl);
      const alert = await screen.findByRole("alert");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(alert.textContent).toBe(COPY_FAILED_MESSAGE);
      expect(alert.closest("[aria-live]")).toBeNull();
      expect(alert.closest('[role="status"]')).toBeNull();
      expect(statusNode().textContent).toBe("");
      const live = baseElement.querySelectorAll("[role=alert],[aria-live]");
      expect(live).toHaveLength(3);
      for (const a of live) {
        for (const b of live) {
          if (a !== b) expect(a.contains(b)).toBe(false);
        }
      }
      expect(document.activeElement).toBe(copyUrl);
      await expectNoA11yViolations(baseElement);
    });

    it("keeps focus on the pressed button after a success", async () => {
      render(<HostMcpDialog open onClose={() => undefined} hasProject />);
      const snippet = screen.getByRole("button", { name: "Copy config" });
      snippet.focus();
      fireEvent.click(snippet);
      await screen.findByText("Copied config");
      expect(document.activeElement).toBe(snippet);
    });

    it("empties the status before a repeat identical success speaks again", async () => {
      render(<HostMcpDialog open onClose={() => undefined} hasProject />);
      const node = statusNode();
      const seen: string[] = [];
      const observer = new MutationObserver(() => {
        seen.push(node.textContent ?? "");
      });
      observer.observe(node, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      const copyUrl = screen.getByRole("button", { name: "Copy address" });
      fireEvent.click(copyUrl);
      await waitFor(() => expect(node.textContent).toBe("Copied address"));
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.click(copyUrl);
      await waitFor(() => expect(seen).toContain(""));
      await waitFor(() => expect(seen.at(-1)).toBe("Copied address"));
      observer.disconnect();
      expect(seen).toEqual(["Copied address", "", "Copied address"]);
      expect(statusNode()).toBe(node);
    });

    it("drops a stale Copied status when an earlier overlapping copy fails", async () => {
      vi.useFakeTimers();
      try {
        let rejectFirst: (error: Error) => void = () => undefined;
        const writeText = vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<void>((_resolve, reject) => {
                rejectFirst = reject;
              }),
          )
          .mockResolvedValueOnce(undefined);
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText },
        });
        render(<HostMcpDialog open onClose={() => undefined} hasProject />);
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
        });
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Copy config" }));
        });
        expect(statusNode().textContent).toBe("Copied config");
        await act(async () => {
          rejectFirst(new Error("denied"));
        });
        act(() => {
          vi.advanceTimersByTime(10_000);
        });
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        expect(statusNode().textContent).toBe("");
        expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
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
        await click("Copy address");
        const first = screen.getByRole("alert");
        act(() => {
          vi.advanceTimersByTime(5000);
        });
        expect(screen.getByRole("alert")).toBe(first);
        await click("Copy address");
        const second = screen.getByRole("alert");
        expect(second).not.toBe(first);
        expect(second.isConnected).toBe(true);
        expect(first.isConnected).toBe(false);
        expect(second.textContent).toBe(COPY_FAILED_MESSAGE);
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        await click("Copy address");
        expect(screen.queryAllByRole("alert")).toHaveLength(0);
        expect(statusNode().textContent).toBe("Copied address");
      });

      it("clears the alert and the status when the dialog closes and reopens", async () => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: vi.fn().mockRejectedValue(new Error("x")) },
        });
        const { rerender } = render(
          <HostMcpDialog open onClose={() => undefined} hasProject />,
        );
        await click("Copy address");
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
    expect(
      await screen.findByText(
        "Open an episode first. Your AI app has nothing to work on until you do.",
      ),
    ).toBeTruthy();
    await expectNoA11yViolations(container);
  });
});

describe("HostMcpDialog last-used line", () => {
  const FAKE = [
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "performance",
    "Date",
  ] as const;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    activityMock.mockReset();
    activityMock.mockResolvedValue(NEVER);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });
  afterEach(() => vi.useRealTimers());

  const used = (age_seconds: number) => ({
    mounted: true,
    last_request_at: "2026-01-01T00:00:00Z",
    age_seconds,
  });
  const NEVER_ANSWERS = () => new Promise<never>(() => undefined);

  async function openDialog(
    extra: Partial<Parameters<typeof HostMcpDialog>[0]> = {},
  ) {
    const view = render(
      <HostMcpDialog open onClose={() => undefined} hasProject {...extra} />,
    );
    await act(async () => {});
    return view;
  }
  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }
  const line = () =>
    document.querySelector<HTMLElement>(".host-mcp-activity")!.textContent;
  const live = () =>
    document.querySelector<HTMLElement>(".host-mcp-activity-live")!;

  it("says nothing while the first answer is pending", async () => {
    activityMock.mockImplementation(NEVER_ANSWERS);
    await openDialog();
    expect(line()).toBe("");
    expect(live().textContent).toBe("");
  });

  it("says no app has used the address yet", async () => {
    await openDialog();
    expect(line()).toBe("No app has used this address since Studio started.");
  });

  it.each([
    [0, "An app used this address just now."],
    [59, "An app used this address just now."],
    [60, "An app used this address 1 minute ago."],
    [125, "An app used this address 2 minutes ago."],
    [600, "An app used this address 10 minutes ago."],
    [601, "Last used 10 minutes ago."],
    [3599, "Last used 59 minutes ago."],
    [3600, "Last used 1 hour ago."],
    [7300, "Last used 2 hours ago."],
    [86_400, "Last used 1 day ago."],
    [3 * 86_400, "Last used 3 days ago."],
  ])("reads %i s as %s", async (age, expected) => {
    activityMock.mockResolvedValue(used(age));
    await openDialog();
    expect(line()).toBe(expected);
  });

  it("counts up and turns neutral past 10 minutes with no new answer", async () => {
    activityMock.mockResolvedValueOnce(used(590));
    activityMock.mockImplementation(NEVER_ANSWERS);
    await openDialog();
    expect(line()).toBe("An app used this address 9 minutes ago.");
    expect(live().textContent).toBe("");
    await advance(15_000);
    expect(line()).toBe("Last used 10 minutes ago.");
    expect(live().textContent).toBe("Last used 10 minutes ago.");
    await advance(2000);
    expect(live().textContent).toBe("");
  });

  it("does not announce the first answer or a minute ticking over", async () => {
    activityMock.mockResolvedValueOnce(used(50));
    activityMock.mockImplementation(NEVER_ANSWERS);
    await openDialog();
    expect(live().textContent).toBe("");
    const seen: string[] = [];
    const observer = new MutationObserver(() =>
      seen.push(live().textContent ?? ""),
    );
    observer.observe(live(), {
      childList: true,
      characterData: true,
      subtree: true,
    });
    await advance(30_000);
    observer.disconnect();
    expect(line()).toBe("An app used this address 1 minute ago.");
    expect(seen).toEqual([]);
  });

  it("announces when the kind changes, once, and leaves the copy status alone", async () => {
    activityMock.mockResolvedValueOnce(NEVER);
    activityMock.mockResolvedValue(used(1));
    await openDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    });
    expect(document.querySelector(".share-dialog-status")!.textContent).toBe(
      "Copied address",
    );
    await advance(3000);
    expect(live().textContent).toBe("An app used this address just now.");
    expect(document.querySelector(".share-dialog-status")!.textContent).toBe(
      "",
    );
    await advance(2000);
    expect(live().textContent).toBe("");
  });

  it("keeps the last line when a check fails, and keeps checking", async () => {
    activityMock.mockResolvedValueOnce(used(5));
    activityMock.mockRejectedValue(new ApiError("down", "network_error"));
    await openDialog();
    await advance(9000);
    expect(line()).toBe("An app used this address just now.");
    expect(activityMock.mock.calls.length).toBeGreaterThan(2);
  });

  it("treats a timed-out read as a failed check: it keeps the last line and keeps checking", async () => {
    activityMock.mockResolvedValueOnce(used(5));
    activityMock.mockRejectedValueOnce(
      new DOMException("The host didn't answer.", "TimeoutError"),
    );
    activityMock.mockResolvedValue(used(65));
    await openDialog();
    await advance(3000);
    expect(line()).toBe("An app used this address just now.");
    await advance(3000);
    expect(line()).toBe("An app used this address 1 minute ago.");
  });

  it("stays blank when the first check fails", async () => {
    activityMock.mockRejectedValue(new Error("bad shape"));
    await openDialog();
    expect(line()).toBe("");
  });

  it.each([401, 403, 404])("stops asking after a %i", async (status) => {
    activityMock.mockRejectedValue(new ApiError("no", null, status));
    await openDialog();
    const calls = activityMock.mock.calls.length;
    await advance(12_000);
    expect(activityMock.mock.calls.length).toBe(calls);
    expect(line()).toBe("");
  });

  describe("when the host cannot accept connections", () => {
    beforeEach(() => {
      activityMock.mockResolvedValue({
        mounted: false,
        last_request_at: null,
        age_seconds: null,
      });
    });

    it("explains, drops the steps, fields and footer, and keeps the link", async () => {
      await openDialog();
      expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeTruthy();
      expect(document.querySelector(".host-mcp-steps")).toBeNull();
      expect(screen.queryByLabelText("Connection address")).toBeNull();
      expect(screen.queryByText("Config file format")).toBeNull();
      expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
      expect(screen.getByRole("link", { name: /Setup guide/ })).toBeTruthy();
      expect(line()).toBe("");
    });

    it("moves focus to the explanation instead of losing it, and stops asking", async () => {
      let answer: (v: unknown) => void = () => undefined;
      activityMock.mockImplementationOnce(
        () => new Promise((resolve) => (answer = resolve)) as never,
      );
      render(<HostMcpDialog open onClose={() => undefined} hasProject />);
      const copy = screen.getByRole("button", { name: "Copy address" });
      act(() => copy.focus());
      expect(document.activeElement).toBe(copy);
      await act(async () =>
        answer({ mounted: false, last_request_at: null, age_seconds: null }),
      );
      expect(document.activeElement).toBe(
        screen.getByText(UNAVAILABLE_MESSAGE),
      );
      const calls = activityMock.mock.calls.length;
      await advance(12_000);
      expect(activityMock.mock.calls.length).toBe(calls);
    });

    it("does not announce itself as the first answer", async () => {
      await openDialog();
      expect(live().textContent).toBe("");
    });

    it("is axe-clean", async () => {
      vi.useRealTimers();
      const { baseElement } = await openDialog();
      await expectNoA11yViolations(baseElement);
    });
  });

  it("does not speak a move to unavailable; focus lands on its paragraph", async () => {
    activityMock.mockResolvedValueOnce(NEVER);
    activityMock.mockResolvedValue({
      mounted: false,
      last_request_at: null,
      age_seconds: null,
    });
    await openDialog();
    await advance(3000);
    expect(live().textContent).toBe("");
    expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument();
  });

  it("asks nothing while closed, and starts blank when reopened", async () => {
    const { rerender } = render(
      <HostMcpDialog open={false} onClose={() => undefined} hasProject />,
    );
    await advance(10_000);
    expect(activityMock).not.toHaveBeenCalled();
    activityMock.mockResolvedValueOnce(used(5));
    rerender(<HostMcpDialog open onClose={() => undefined} hasProject />);
    await act(async () => {});
    expect(line()).toBe("An app used this address just now.");
    rerender(
      <HostMcpDialog open={false} onClose={() => undefined} hasProject />,
    );
    activityMock.mockImplementation(NEVER_ANSWERS);
    rerender(<HostMcpDialog open onClose={() => undefined} hasProject />);
    await act(async () => {});
    expect(line()).toBe("");
  });

  it("drops the discarded StrictMode read and keeps one polling cadence", async () => {
    let finishDiscarded: (answer: ReturnType<typeof used>) => void = () =>
      undefined;
    activityMock
      .mockImplementationOnce(
        () => new Promise((resolve) => (finishDiscarded = resolve)),
      )
      .mockResolvedValue(NEVER);
    render(
      <StrictMode>
        <HostMcpDialog open onClose={() => undefined} hasProject />
      </StrictMode>,
    );
    await act(async () => {});
    expect(activityMock).toHaveBeenCalledTimes(2);
    expect(activityMock.mock.calls[0][0]?.aborted).toBe(true);
    expect(activityMock.mock.calls[1][0]?.aborted).toBe(false);

    await act(async () => finishDiscarded(used(0)));
    expect(line()).toBe("No app has used this address since Studio started.");
    await advance(ACTIVITY_POLL_MS);
    expect(activityMock).toHaveBeenCalledTimes(3);
  });

  it("drops an answer that lands after the dialog closed", async () => {
    let finish: (v: ReturnType<typeof used>) => void = () => undefined;
    activityMock.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const { rerender } = await openDialog();
    rerender(
      <HostMcpDialog open={false} onClose={() => undefined} hasProject />,
    );
    activityMock.mockImplementation(NEVER_ANSWERS);
    rerender(<HostMcpDialog open onClose={() => undefined} hasProject />);
    await act(async () => finish(used(5)));
    expect(line()).toBe("");
  });

  it("does not ask when given a fixed address or a fixed answer", async () => {
    const first = await openDialog({ mcpUrl: "http://127.0.0.1:8765/mcp" });
    await advance(10_000);
    expect(activityMock).not.toHaveBeenCalled();
    first.unmount();
    await openDialog({ activityPreview: used(125) });
    await advance(10_000);
    expect(activityMock).not.toHaveBeenCalled();
    expect(line()).toBe("An app used this address 2 minutes ago.");
  });

  it("keeps the config behind a closed disclosure that closes again on reopen", async () => {
    const { rerender } = await openDialog();
    const details = () =>
      document.querySelector<HTMLDetailsElement>(".host-mcp-config")!;
    expect(details().open).toBe(false);
    expect(details().querySelector("summary")!.textContent).toBe(
      "Config file format",
    );
    act(() => {
      details().open = true;
    });
    expect(details().open).toBe(true);
    rerender(
      <HostMcpDialog open={false} onClose={() => undefined} hasProject />,
    );
    rerender(<HostMcpDialog open onClose={() => undefined} hasProject />);
    await act(async () => {});
    expect(details().open).toBe(false);
  });

  it("has one setup link that opens in a new tab and says so", async () => {
    await openDialog();
    const link = screen.getByRole("link", { name: /Setup guide/ });
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(link.getAttribute("href")).toBe(MCP_SETUP_GUIDE_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("opens in a new tab");
    expect(MCP_SETUP_GUIDE_URL).toBe(
      "https://docs.sharecut.studio/#/mcp-setup",
    );
  });

  it("names no app and never says connected, in any state", async () => {
    const forbidden =
      /cursor|claude|figma|chatgpt|codex|windsurf|vs ?code|copilot|gemini|connected|online|live\b/i;
    for (const answer of [
      NEVER,
      used(5),
      used(900),
      { mounted: false, last_request_at: null, age_seconds: null },
    ]) {
      activityMock.mockResolvedValue(answer);
      const { baseElement, unmount } = await openDialog();
      const copy = (baseElement.textContent ?? "").replace(/"sharecut"/g, "");
      expect(copy).not.toMatch(forbidden);
      unmount();
    }
  });

  it("is axe-clean with the disclosure closed and open", async () => {
    vi.useRealTimers();
    const { baseElement } = await openDialog();
    await expectNoA11yViolations(baseElement);
    act(() => {
      document.querySelector<HTMLDetailsElement>(".host-mcp-config")!.open =
        true;
    });
    await expectNoA11yViolations(baseElement);
  });
});
