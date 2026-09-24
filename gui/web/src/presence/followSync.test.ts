import { describe, expect, it } from "vitest";
import {
  expectedPlayheadSec,
  followBannerDetail,
  isLocalPresenceClient,
  isObservingClient,
  isProgrammaticScroll,
  type NudgeClock,
  planCorrection,
  planFollowUi,
  remotePresenceClients,
  resolveFollowTarget,
  viewportToZoomScroll,
  withProgrammaticScroll,
  zoomScrollToViewport,
} from "./followSync";

describe("followSync", () => {
  it("extrapolates a playing playhead and clamps", () => {
    const t = {
      playing: true,
      playhead_sec: 10,
      rate: 1,
      stamped_ns: 1_000_000_000,
    };
    expect(expectedPlayheadSec(t, 2000, 60)).toBeCloseTo(11, 5);
    expect(expectedPlayheadSec({ ...t, playing: false }, 5000, 60)).toBe(10);
    expect(expectedPlayheadSec(t, 2000, 10.2)).toBeCloseTo(10.2, 5);
  });

  it("plans seek / nudge / none by drift band", () => {
    const clock: NudgeClock = { startedAt: null };
    expect(planCorrection(1, 1.4, undefined, 0, clock).action).toBe("seek");
    expect(planCorrection(1, 1.12, undefined, 0, clock)).toEqual({
      action: "nudge",
      rate: 1.03,
    });
    expect(planCorrection(1, 1.02, undefined, 0, clock)).toEqual({
      action: "none",
    });
  });

  it("seeks after a nudge lasts more than 1s", () => {
    const clock: NudgeClock = { startedAt: null };
    expect(planCorrection(1, 1.12, undefined, 0, clock).action).toBe("nudge");
    expect(planCorrection(1, 1.12, undefined, 1001, clock)).toEqual({
      action: "seek",
      toSec: 1.12,
    });
  });

  it("converts viewport to zoom and scroll", () => {
    const { zoomPxPerSec, scrollLeft } = viewportToZoomScroll(
      { start_sec: 10, end_sec: 20 },
      200,
    );
    expect(zoomPxPerSec).toBe(20);
    expect(scrollLeft).toBe(200);
  });

  it("round-trips a viewport through zoom and scroll", () => {
    const viewport = zoomScrollToViewport(200, 20, 200);
    expect(viewport).toEqual({ start_sec: 10, end_sec: 20 });
    expect(viewportToZoomScroll(viewport, 200)).toEqual({
      zoomPxPerSec: 20,
      scrollLeft: 200,
    });
  });

  it("shifts a padded viewport to 0 instead of shrinking it (#385)", () => {
    // 150px before 0 at 10px/s in a 400px view: still a 40 s window.
    expect(zoomScrollToViewport(-150, 10, 400)).toEqual({
      start_sec: 0,
      end_sec: 40,
    });
    // Unmeasured (no timeline element) and far before 0: never negative.
    expect(zoomScrollToViewport(-7800, 10, 0)).toEqual({
      start_sec: 0,
      end_sec: 60,
    });
  });

  it("treats a following client as observing", () => {
    expect(isObservingClient({ meta: { following: "host" } })).toBe(true);
    expect(isObservingClient({ meta: { following: null } })).toBe(false);
    expect(isObservingClient({ meta: {} })).toBe(false);
  });

  it("hides the roster until local client id is known", () => {
    const clients = [
      { client_id: "me", last_seen_ns: Date.now() * 1e6 },
      { client_id: "them", last_seen_ns: Date.now() * 1e6 },
    ];
    expect(remotePresenceClients(clients, null, Date.now())).toEqual([]);
    expect(
      remotePresenceClients(clients, "me", Date.now()).map((c) => c.client_id),
    ).toEqual(["them"]);
  });

  it("hides the guest-rewritten form of the local viewer id", () => {
    const now = Date.now() * 1e6;
    const clients = [
      { client_id: "guest-statuesq-viewer-c0fd30de", last_seen_ns: now },
      { client_id: "guest-statuesq-viewer-997f058f", last_seen_ns: now },
    ];
    expect(
      remotePresenceClients(clients, "viewer-c0fd30de", Date.now()).map(
        (c) => c.client_id,
      ),
    ).toEqual(["guest-statuesq-viewer-997f058f"]);
    expect(
      isLocalPresenceClient(
        "guest-statuesq-viewer-c0fd30de",
        "viewer-c0fd30de",
      ),
    ).toBe(true);
  });

  it("walks a follow chain to the live root leader", () => {
    const now = Date.now();
    const clients = [
      {
        client_id: "a",
        last_seen_ns: now * 1e6,
        meta: { following: "b" },
      },
      {
        client_id: "b",
        last_seen_ns: now * 1e6,
        meta: {
          following: "c",
          transport: { playing: true, playhead_sec: 3, rate: 1 },
        },
      },
      {
        client_id: "c",
        last_seen_ns: now * 1e6,
        meta: { transport: { playing: true, playhead_sec: 9, rate: 1 } },
      },
    ];
    expect(resolveFollowTarget(clients, "a", now)?.client_id).toBe("c");
  });

  it("returns null for a stale or cyclic follow target", () => {
    const now = Date.now();
    expect(resolveFollowTarget([], "gone", now)).toBeNull();
    const cycle = [
      {
        client_id: "a",
        last_seen_ns: now * 1e6,
        meta: { following: "b" },
      },
      {
        client_id: "b",
        last_seen_ns: now * 1e6,
        meta: { following: "a" },
      },
    ];
    expect(resolveFollowTarget(cycle, "a", now)).toBeNull();
  });

  it("plans host desktop follow for tab, audition, and monitor maps", () => {
    const plan = planFollowUi(
      {
        tab: "comments",
        audition: "fx",
        viewer_mute: ["host"],
        solo: ["guest"],
      },
      { guestShare: false, breakpoint: "desktop" },
    );
    expect(plan.apply.tab).toBe("comments");
    expect(plan.apply.audition).toBe("fx");
    expect(plan.apply.viewerMute).toEqual({ host: true });
    expect(plan.apply.soloTracks).toEqual({ guest: true });
    expect(plan.degraded).toEqual({});
  });

  it("degrades guest follow for host-only tabs and non-Mix audition", () => {
    const pipeline = planFollowUi(
      { tab: "pipeline", audition: "fx", viewer_mute: ["host"], solo: ["g"] },
      { guestShare: true, breakpoint: "desktop" },
    );
    expect(pipeline.apply.tab).toBeUndefined();
    expect(pipeline.degraded.tab).toBe("pipeline");
    expect(pipeline.degraded.audition).toBe("fx");
    expect(pipeline.apply.audition).toBe("mix");
    expect(pipeline.apply.viewerMute).toBeUndefined();
    expect(pipeline.apply.soloTracks).toBeUndefined();

    const mix = planFollowUi(
      { tab: "transcript", audition: "mix" },
      { guestShare: true, breakpoint: "desktop" },
    );
    expect(mix.apply.tab).toBe("transcript");
    expect(mix.apply.audition).toBe("mix");
    expect(mix.degraded.audition).toBeUndefined();

    const omitted = planFollowUi(
      { tab: "transcript" },
      { guestShare: true, breakpoint: "desktop" },
    );
    expect(omitted.apply.audition).toBe("mix");
    expect(omitted.degraded.audition).toBeUndefined();
  });

  it("ignores removed tabs instead of applying empty chrome", () => {
    const plan = planFollowUi(
      { tab: "mix" as never, audition: "fx" },
      { guestShare: false, breakpoint: "desktop" },
    );
    expect(plan.apply.tab).toBeUndefined();
    expect(plan.apply.audition).toBe("fx");
    expect(plan.degraded.tab).toBeUndefined();
  });

  it("maps leader tabs to phone modes", () => {
    const comments = planFollowUi(
      { tab: "comments" },
      { guestShare: false, breakpoint: "phone" },
    );
    expect(comments.apply.mobile).toEqual({
      mobileMode: "more",
      moreDestination: "comments",
    });
    const text = planFollowUi(
      { tab: "transcript" },
      { guestShare: false, breakpoint: "phone" },
    );
    expect(text.apply.mobile).toEqual({ mobileMode: "text" });
  });

  it("prefers published mobile_mode on phone", () => {
    const listen = planFollowUi(
      { tab: "transcript", mobile_mode: "listen" },
      { guestShare: false, breakpoint: "phone" },
    );
    expect(listen.apply.mobile).toEqual({ mobileMode: "listen" });
    const timeline = planFollowUi(
      { tab: "transcript", mobile_mode: "timeline" },
      { guestShare: false, breakpoint: "phone" },
    );
    expect(timeline.apply.mobile).toEqual({ mobileMode: "timeline" });
  });

  it("formats follow banner degrade strings", () => {
    expect(
      followBannerDetail({ tab: "pipeline", audition: "fx" }, (t) =>
        t === "pipeline" ? "Pipeline" : t,
      ),
    ).toBe(" · in Pipeline (host-only) · auditioning FX");
    expect(followBannerDetail({}, () => "x")).toBe("");
  });

  it("holds programmatic scroll across animation frames", async () => {
    withProgrammaticScroll(() => {
      expect(isProgrammaticScroll()).toBe(true);
    });
    expect(isProgrammaticScroll()).toBe(true);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(isProgrammaticScroll()).toBe(false);
  });
});
