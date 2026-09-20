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
