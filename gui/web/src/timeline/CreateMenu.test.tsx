import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { CreateMenu, type CreateMenuPlace } from "./CreateMenu";
import type { CreateView, HitRouter } from "./hitRouting";

const runPointerCommand = vi.hoisted(() => vi.fn());
vi.mock("../commands/pointer", () => ({ runPointerCommand }));

let router: HitRouter;
let view: CreateView;
const place: CreateMenuPlace = {
  atTime: 12.5,
  trackId: "host",
  trackLabel: "Avery",
  lane: { top: 100, bottom: 204 },
  level: 0.8,
};
const bounds = { left: 0, top: 0, right: 430, bottom: 700 };

function open(projectPath: string, shareCapabilities: string[] | null = null) {
  useDawStore.setState({
    projectPath,
    shareCapabilities,
    guestMode: shareCapabilities ? "edit" : null,
    project: minimalProject({ tracks: [sampleTrack({ id: "host" })] }),
  });
  return render(
    <CreateMenu
      view={view}
      place={place}
      router={router}
      bounds={bounds}
      avoidX={215}
    />,
  );
}

beforeEach(() => {
  runPointerCommand.mockClear();
  router = {
    dispose: vi.fn(),
    defers: vi.fn(() => false),
    longPress: vi.fn(),
    choose: vi.fn(),
    nextPage: vi.fn(),
    close: vi.fn(),
    adopt: vi.fn(() => vi.fn()),
  };
  view = {
    origin: { x: 120, y: 150 },
    surface: document.body,
    fingerDown: false,
    over: null,
  };
});

afterEach(cleanup);

describe("CreateMenu", () => {
  it("names the held time and lane, and lists what can be made there", () => {
    open("/tmp/ep.project.json");
    const menu = screen.getByRole("menu", { name: /Avery/ });
    expect(
      [...menu.querySelectorAll('[role="menuitem"]')].map((el) =>
        el.textContent?.trim(),
      ),
    ).toEqual([
      "Add envelope point0.80×",
      "Blade cut",
      "Add chapter",
      "Add comment",
    ]);
    expect(useDawStore.getState().statusAnnouncement).toMatch(
      /^Create at .+ on Avery, 4 actions$/,
    );
  });

  it("runs the entry's command at the held time and lane, and closes", () => {
    open("/tmp/ep.project.json");
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Add envelope point/ }),
    );

    expect(router.close).toHaveBeenCalledOnce();
    expect(runPointerCommand).toHaveBeenCalledWith("envelope.addPoint", {
      atTime: 12.5,
      trackId: "host",
    });
  });

  it("keeps an entry the session cannot run, disabled, with its reason beside it", () => {
    open("share:tok", ["view", "play", "comment", "reply"]);
    const envelope = screen.getByRole("menuitem", {
      name: /Add envelope point/,
    });
    expect(envelope).toHaveAttribute("aria-disabled", "true");
    expect(envelope).toHaveAccessibleDescription(
      "Only the host and editors can change envelopes",
    );
    fireEvent.click(envelope);
    expect(runPointerCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("menuitem", { name: "Add comment" }));
    expect(runPointerCommand).toHaveBeenCalledWith("comment.draftAt", {
      atTime: 12.5,
      trackId: "host",
    });
  });

  it("lets an editor link add envelope points", () => {
    open("share:tok", ["view", "play", "comment", "reply", "suggest", "edit"]);
    expect(
      screen.getByRole("menuitem", { name: /Add envelope point/ }),
    ).not.toHaveAttribute("aria-disabled");
  });

  it("marks the item under a sliding finger, and closes from its scrim", () => {
    view = { ...view, fingerDown: true, over: 1 };
    const { container } = open("/tmp/ep.project.json");
    expect(screen.getByRole("menuitem", { name: "Blade cut" })).toHaveClass(
      "is-over",
    );
    fireEvent.pointerDown(
      document.body.querySelector(".create-menu-scrim") as Element,
    );
    expect(router.close).toHaveBeenCalledOnce();
    expect(container).toBeTruthy();
  });

  it("has no axe violations", async () => {
    open("share:tok", ["view", "play", "comment", "reply"]);
    await expectNoA11yViolations(
      document.querySelector(".create-menu-layer") as HTMLElement,
    );
  });
});
