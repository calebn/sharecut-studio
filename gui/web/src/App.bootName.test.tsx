import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { urlOf } from "./test/urlOf";

vi.mock("./dawApp", () => new Promise(() => {}));
vi.mock("./record/GuestRoomApp", () => new Promise(() => {}));

const offline = vi.hoisted(() => ({ load: vi.fn(), clear: vi.fn() }));

vi.mock("./services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./services/offlineQueue/offlineStore")
  >()),
  loadOfflineSnapshot: offline.load,
  clearOfflineSnapshot: offline.clear,
}));

const never = () => vi.fn(() => new Promise<Response>(() => {}));

const answers = (project: Response | "fail") =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.includes("/features"))
      return new Response(
        JSON.stringify({ api_version: 1, features: ["share.ui.routes"] }),
        { status: 200 },
      );
    if (url.endsWith("/project") && project !== "fail") return project.clone();
    throw new TypeError("Failed to fetch");
  });

const projectNamed = (name: string) =>
  new Response(
    JSON.stringify({
      capabilities: ["view", "comment"],
      guest_mode: "comment",
      reads_transcript_words: false,
      meta: { name },
    }),
    { status: 200 },
  );

describe("the name the server wrote into the page", () => {
  beforeEach(() => {
    offline.load.mockReset();
    offline.clear.mockReset();
    resetFeaturesCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    resetFeaturesCache();
  });

  it("is on the review loading screen from the first render, before /project answers", () => {
    window.history.pushState({}, "", "/r/named");
    vi.stubGlobal("fetch", never());
    const { container } = render(<App bootName="Pilot episode" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading Pilot episode…",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Pilot episode",
    );
    expect(container.querySelector(".sys-header-title")).toHaveTextContent(
      "Pilot episode",
    );
    expect(container.querySelector(".sys-skeleton-block--title")).toBeNull();
  });

  it("gives way to the name /project answers with", async () => {
    window.history.pushState({}, "", "/r/named");
    vi.stubGlobal("fetch", answers(projectNamed("Renamed episode")));
    render(<App bootName="Pilot episode" />);
    await vi.waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Loading Renamed episode…",
      );
    });
  });

  it("gives way to the saved copy's name when /project does not answer", async () => {
    window.history.pushState({}, "", "/r/named");
    offline.load.mockResolvedValue({
      project: { meta: { name: "Saved episode" } },
      saved_at: 1,
    });
    vi.stubGlobal("fetch", answers("fail"));
    render(<App bootName="Pilot episode" />);
    await vi.waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Loading Saved episode…",
      );
    });
  });

  it("is not shown by the recording room's loading screen", () => {
    window.history.pushState({}, "", "/rec/rec-tok");
    vi.stubGlobal("fetch", never());
    const { container } = render(<App bootName="Pilot episode" />);
    expect(screen.getByRole("status")).toHaveTextContent("Joining the room…");
    expect(container.textContent).not.toContain("Pilot episode");
  });

  it("is not shown by a host's loading screen", () => {
    window.history.pushState({}, "", "/?project=/home/host/ep.sharecut");
    vi.stubGlobal("fetch", never());
    const { container } = render(<App bootName="Pilot episode" />);
    expect(container.textContent).not.toContain("Pilot episode");
    expect(container.querySelector("main.guest-loading")).toBeNull();
  });

  it("is no name at all when the page carries none", () => {
    window.history.pushState({}, "", "/r/named");
    vi.stubGlobal("fetch", never());
    render(<App bootName={null} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading the episode…",
    );
  });

  it("is not shown on a share project key, which is no review route", () => {
    window.history.pushState({}, "", "/?project=share:direct-token");
    vi.stubGlobal("fetch", never());
    const { container } = render(<App bootName="Pilot episode" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading the episode…",
    );
    expect(container.textContent).not.toContain("Pilot episode");
  });
});
