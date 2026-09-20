import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { urlOf } from "./test/urlOf";

const guestBootstrap = {
  mode: "record",
  kind: "record",
  token: "rec-tok",
  role: "guest",
  session_id: "room1",
  capabilities: ["join", "monitor", "comment"],
  episode: { name: "Episode" },
  room: { recorded_cap: 4, producer_cap: 2 },
  build: { capture: true, monitor: false, upload: false },
  expires_at: null,
};

describe("App record route", () => {
  beforeEach(() => {
    resetFeaturesCache();
    window.history.pushState({}, "", "/rec/rec-tok");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    resetFeaturesCache();
  });

  it("renders RecordApp and never ReviewApp or /api/review/", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes("/api/review/")) {
        throw new Error(`unexpected review fetch: ${url}`);
      }
      if (url.includes("/api/rec/rec-tok/features")) {
        return new Response(
          JSON.stringify({
            api_version: 1,
            features: ["share.ui.routes", "share.ui.banner", "share.ui.menu"],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/rec/rec-tok/bootstrap")) {
        return new Response(JSON.stringify(guestBootstrap), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Join the recording" }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole("main", { name: /review/i })).toBeNull();
    expect(
      fetchMock.mock.calls.some((call) =>
        urlOf(call[0] as RequestInfo | URL).includes("/api/review/"),
      ),
    ).toBe(false);
  });
});
