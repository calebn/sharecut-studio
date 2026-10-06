import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { urlOf } from "./test/urlOf";

describe("App review route", () => {
  beforeEach(() => {
    resetFeaturesCache();
    window.history.pushState({}, "", "/r/no-view");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    resetFeaturesCache();
  });

  it("refuses a share without view instead of opening a listen page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes("/features")) {
        return new Response(
          JSON.stringify({
            api_version: 1,
            features: ["share.ui.routes", "share.ui.banner", "share.ui.menu"],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/review/no-view/project")) {
        return new Response(
          JSON.stringify({
            capabilities: ["play", "comment"],
            guest_mode: "comment",
            meta: { name: "Episode" },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(
      await screen.findByText("This link does not open the project."),
    ).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("This link does not open the project.");
    expect(alert).toHaveTextContent(
      "Ask the person who shared it for a new link.",
    );
    expect(
      fetchMock.mock.calls.some((call) =>
        urlOf(call[0] as RequestInfo | URL).endsWith("/audio"),
      ),
    ).toBe(false);
  });
});
