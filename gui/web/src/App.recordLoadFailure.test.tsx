import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { urlOf } from "./test/urlOf";

vi.mock("./record/GuestRoomApp", () => ({
  get GuestRoomApp(): never {
    throw new TypeError(
      "Failed to fetch dynamically imported module: /assets/GuestRoomApp-abc.js",
    );
  },
}));

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

const STATE_WAIT_MS = 5_000;

describe("App record route when the room code fails to load", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetFeaturesCache();
    window.history.pushState({}, "", "/rec/rec-tok");
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        urlOf(input).includes("/api/rec/rec-tok/features")
          ? new Response(
              JSON.stringify({
                api_version: 1,
                features: [
                  "share.ui.routes",
                  "share.ui.banner",
                  "share.ui.menu",
                ],
              }),
              { status: 200 },
            )
          : urlOf(input).includes("/api/rec/rec-tok/bootstrap")
            ? new Response(JSON.stringify(guestBootstrap), { status: 200 })
            : new Response("not found", { status: 404 }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    resetFeaturesCache();
  });

  it(
    "shows a cover with Reload and a tab title, not a blank page",
    async () => {
      const { container } = render(<App />);
      expect(
        await screen.findByRole(
          "heading",
          { level: 1, name: "Couldn't reach the room" },
          { timeout: STATE_WAIT_MS },
        ),
      ).toBeInTheDocument();
      expect(container).not.toBeEmptyDOMElement();
      expect(document.title).toBe("Couldn't reach the room | ShareCut Studio");
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      expect(reload).toHaveBeenCalledTimes(1);
    },
    2 * STATE_WAIT_MS,
  );
});
