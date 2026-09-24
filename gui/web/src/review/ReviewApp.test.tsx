import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { sampleComment } from "../test/fixtures";
import { urlOf } from "../test/urlOf";
import { ReviewApp } from "./ReviewApp";

const reviewProject = {
  mode: "review",
  guest_mode: "comment",
  token: "tok",
  meta: { name: "Shot of Truth — Eladio" },
  timeline_duration_sec: 120,
  review_version: { id: "v1", label: "Guest" },
  comments: [
    sampleComment({
      action_items: [
        {
          id: "a1",
          text: "Trim intro",
          done: false,
          completed_at: null,
          completed_by: null,
        },
      ],
    }),
  ],
  capabilities: ["play", "comment", "reply", "action"],
};

function jsonRequestBody(init?: RequestInit): unknown {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error(`expected JSON string body, got ${typeof body}`);
  }
  return JSON.parse(body) as unknown;
}

describe("ReviewApp", () => {
  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.OPEN;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    url: string;
    constructor(url: string) {
      this.url = url;
      FakeWebSocket.instances.push(this);
    }
    close() {
      this.onclose?.();
    }
    emit(msg: unknown) {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "modelContext");
  });

  it("exposes a main landmark and is axe-clean", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/project")) {
          return new Response(JSON.stringify(reviewProject), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const { container } = render(<ReviewApp token="tok" />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Shot of Truth — Eladio" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Reply…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Trim intro/ })).toBeEnabled();
    await expectNoA11yViolations(container);
  });

  it("filters resolved threads while keeping them readable in the full review", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/project")) {
          return new Response(
            JSON.stringify({
              ...reviewProject,
              comments: [
                sampleComment({
                  id: "open",
                  body: "Needs a cut",
                  resolved: false,
                }),
                sampleComment({
                  id: "done",
                  body: "Cut addressed",
                  resolved: true,
                }),
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    render(<ReviewApp token="tok" />);
    expect(await screen.findByText("Cut addressed")).toBeInTheDocument();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: "Open comments only" }),
    );
    expect(screen.getByText("Needs a cut")).toBeInTheDocument();
    expect(screen.queryByText("Cut addressed")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: "Open comments only" }),
    );
    expect(screen.getByText("Cut addressed")).toBeInTheDocument();
  });

  it("explains when the open-only view has no threads", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/project")) {
          return new Response(
            JSON.stringify({
              ...reviewProject,
              comments: [sampleComment({ resolved: true })],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    render(<ReviewApp token="tok" />);
    await user.click(
      await screen.findByRole("checkbox", { name: "Open comments only" }),
    );
    expect(screen.getByText("No open comments.")).toBeInTheDocument();
  });

  it("refreshes the open-only list after the host resolves a thread", async () => {
    const user = userEvent.setup();
    let resolved = false;
    const intervalSpy = vi.spyOn(window, "setInterval");
    const registerTool = vi.fn();
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: { registerTool },
    });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/project")) {
          return new Response(
            JSON.stringify({
              ...reviewProject,
              comments: [sampleComment({ body: "Host update", resolved })],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    render(<ReviewApp token="tok" />);
    expect(await screen.findByText("Host update")).toBeInTheDocument();
    expect(registerTool).toHaveBeenCalledTimes(3);
    await user.click(
      screen.getByRole("checkbox", { name: "Open comments only" }),
    );
    resolved = true;
    const refreshTick = intervalSpy.mock.calls.find(
      ([, delay]) => delay === 15_000,
    )?.[0] as (() => void) | undefined;
    expect(refreshTick).toBeDefined();
    await act(async () => {
      refreshTick?.();
    });
    expect(screen.getByText("No open comments.")).toBeInTheDocument();
    expect(registerTool).toHaveBeenCalledTimes(3);
  });

  it("skips overlapping polls and aborts an outstanding read on cleanup", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    let finishRead: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          finishRead = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

    const { unmount } = render(<ReviewApp token="tok" />);
    const refreshTick = intervalSpy.mock.calls.find(
      ([, delay]) => delay === 15_000,
    )?.[0] as (() => void) | undefined;
    expect(refreshTick).toBeDefined();
    refreshTick?.();
    refreshTick?.();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRead?.(
        new Response(JSON.stringify(reviewProject), { status: 200 }),
      );
    });
    expect(
      screen.getByRole("heading", { name: reviewProject.meta.name }),
    ).toBeInTheDocument();
    refreshTick?.();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const pendingSignal = fetchMock.mock.calls[1]?.[1]?.signal;
    unmount();
    expect(pendingSignal?.aborted).toBe(true);
  });

  it("clears an initial load error after a successful poll", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (fail) return new Response("offline", { status: 503 });
        return new Response(JSON.stringify(reviewProject), { status: 200 });
      }),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

    render(<ReviewApp token="tok" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    fail = false;
    const refreshTick = intervalSpy.mock.calls.find(
      ([, delay]) => delay === 15_000,
    )?.[0] as (() => void) | undefined;
    await act(async () => {
      refreshTick?.();
    });
    expect(
      screen.getByRole("heading", { name: reviewProject.meta.name }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows action items as read-only without the action capability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/project")) {
          return new Response(
            JSON.stringify({
              ...reviewProject,
              capabilities: ["play", "comment", "reply"],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<ReviewApp token="tok" />);
    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: /Trim intro/ }),
      ).toBeDisabled();
    });
    expect(
      screen.queryByRole("button", { name: "Resolve" }),
    ).not.toBeInTheDocument();
  });

  it("posts replies and action-item toggles over share HTTP", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.includes("/project") && (init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify(reviewProject), { status: 200 });
        }
        if (url.includes("/replies") && init?.method === "POST") {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.includes("/actions/") && init?.method === "POST") {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ReviewApp token="tok" />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Reply…")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("Reply…"), "Sounds good");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => {
      const replyCall = fetchMock.mock.calls.find((call) =>
        urlOf(call[0]).includes("/replies"),
      );
      expect(replyCall).toBeDefined();
      expect(replyCall?.[1]).toEqual(
        expect.objectContaining({ method: "POST" }),
      );
      expect(jsonRequestBody(replyCall?.[1])).toEqual({
        body: "Sounds good",
        author: "viewer",
      });
    });

    await user.click(screen.getByRole("checkbox", { name: /Trim intro/ }));
    await waitFor(() => {
      const actionCall = fetchMock.mock.calls.find((call) =>
        urlOf(call[0]).includes("/actions/"),
      );
      expect(actionCall).toBeDefined();
      expect(actionCall?.[1]).toEqual(
        expect.objectContaining({ method: "POST" }),
      );
      expect(jsonRequestBody(actionCall?.[1])).toEqual({
        done: true,
        by: "viewer",
      });
    });
    expect(
      screen.queryByRole("button", { name: "Resolve" }),
    ).not.toBeInTheDocument();
  });

  it("shows a polite activity chip for guest progress and keeps the terminal state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/project")) {
          return new Response(JSON.stringify(reviewProject), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<ReviewApp token="tok" />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Shot of Truth — Eladio" }),
      ).toBeInTheDocument();
    });
    expect(FakeWebSocket.instances[0]?.url).toContain(
      "/api/review/tok/progress/ws",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "progress",
        plane: "progress",
        kind: "update",
        task_id: "guest_render_preview",
        label: "Render preview",
        message: "Mixing stems",
        status: "running",
        elapsed_sec: 2,
      });
    });
    const live = screen.getByRole("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("aria-busy")).toBe("true");
    expect(live).toHaveTextContent("Activity: running: Mixing stems");
    expect(live).not.toHaveTextContent(/0:02/);
    expect(live).not.toHaveTextContent(/last update/);
    const chip = document.querySelector(".status-pipeline");
    expect(chip).not.toBeNull();
    expect(chip?.closest("button")).toBeNull();
    expect(chip?.tagName).toBe("SPAN");
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "progress",
        plane: "progress",
        kind: "end",
        task_id: "guest_render_preview",
        label: "Render preview",
        message: "done",
        status: "ok",
        elapsed_sec: 4,
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Activity: ok: done");
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBeNull();
  });

  it("reconnects the progress websocket after a drop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/project")) {
          return new Response(JSON.stringify(reviewProject), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    render(<ReviewApp token="tok" />);
    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
    vi.useFakeTimers();
    await act(async () => {
      FakeWebSocket.instances[0].onclose?.();
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(FakeWebSocket.instances.length).toBe(2);
  });
});
