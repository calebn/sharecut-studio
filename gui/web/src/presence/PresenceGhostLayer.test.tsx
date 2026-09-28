import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { sessionRoster } from "../test/fixtures";
import * as colors from "./colors";
import { PresenceGhostLayer } from "./PresenceGhostLayer";

describe("PresenceGhostLayer", () => {
  it("renders nothing when there are no remote anchor cursors", () => {
    useDawStore.setState({
      localClientId: "me",
      sessionClients: sessionRoster([{ client_id: "me", role: "viewer" }]),
    });
    const rootRef = createRef<HTMLDivElement>();
    const { container } = render(<PresenceGhostLayer rootRef={rootRef} />);
    expect(container.querySelector(".presence-ghost-layer")).toBeNull();
  });

  it("hides an unresolved anchor", () => {
    useDawStore.setState({
      localClientId: "me",
      sessionClients: sessionRoster([
        { client_id: "me", role: "viewer" },
        {
          client_id: "them",
          role: "viewer",
          last_seen_ns: Date.now() * 1e6,
          meta: {
            display_name: "Ada",
            cursor: { anchor: "audition:fx", x: 0.5, y: 0.5 },
          },
        },
      ]),
    });
    const rootRef = createRef<HTMLDivElement>();
    const { container } = render(
      <div ref={rootRef}>
        <PresenceGhostLayer rootRef={rootRef} />
      </div>,
    );
    const ghost = container.querySelector(
      ".presence-cursor--ghost",
    ) as HTMLElement;
    expect(ghost).toBeTruthy();
  });

  it("renders a ghost selection for a remote transcript word", () => {
    useDawStore.setState({
      localClientId: "me",
      sessionClients: sessionRoster([
        { client_id: "me", role: "viewer" },
        {
          client_id: "them",
          role: "viewer",
          last_seen_ns: Date.now() * 1e6,
          meta: {
            display_name: "Ada",
            selection: {
              kind: "transcriptWord",
              track_id: "host",
              word_index: 0,
            },
          },
        },
      ]),
    });
    const rootRef = createRef<HTMLDivElement>();
    const { container } = render(
      <div ref={rootRef}>
        <span data-presence-anchor="transcript:word:host:0">hello</span>
        <PresenceGhostLayer rootRef={rootRef} />
      </div>,
    );
    expect(container.querySelector(".presence-selection--ghost")).toBeTruthy();
  });

  it("does not render the local client's ghost", async () => {
    useDawStore.setState({
      localClientId: "me",
      sessionClients: sessionRoster([
        {
          client_id: "me",
          role: "viewer",
          last_seen_ns: Date.now() * 1e6,
          meta: { cursor: { anchor: "audition:fx", x: 0.5, y: 0.5 } },
        },
      ]),
    });
    const rootRef = createRef<HTMLDivElement>();
    const { container } = render(<PresenceGhostLayer rootRef={rootRef} />);
    expect(container.querySelector(".presence-cursor--ghost")).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("drops a ghost for a peer that stops heartbeating with no other store change", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    try {
      useDawStore.setState({
        localClientId: "me",
        sessionClients: sessionRoster([
          { client_id: "me", role: "viewer" },
          {
            client_id: "them",
            role: "viewer",
            last_seen_ns: Date.now() * 1e6,
            meta: {
              display_name: "Ada",
              cursor: { anchor: "audition:fx", x: 0.5, y: 0.5 },
            },
          },
        ]),
      });
      const rootRef = createRef<HTMLDivElement>();
      const { container } = render(
        <div ref={rootRef}>
          <PresenceGhostLayer rootRef={rootRef} />
        </div>,
      );
      expect(container.querySelector(".presence-cursor--ghost")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(35_000);
      });
      expect(container.querySelector(".presence-cursor--ghost")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a PresenceDelta for one client re-renders only that client's ghost row", () => {
    const clients = ["a", "b", "c", "d", "e"].map((id) => ({
      client_id: id,
      role: "viewer",
      last_seen_ns: Date.now() * 1e6,
      meta: {
        display_name: id.toUpperCase(),
        cursor: { anchor: `audition:${id}`, x: 0.5, y: 0.5 },
      },
    }));
    useDawStore.setState({
      localClientId: "me",
      sessionRosterVersion: 5,
      sessionClients: sessionRoster([
        { client_id: "me", role: "viewer" },
        ...clients,
      ]),
    });
    const rootRef = createRef<HTMLDivElement>();
    const spy = vi.spyOn(colors, "rosterDisplayName");
    render(
      <div ref={rootRef}>
        <PresenceGhostLayer rootRef={rootRef} />
      </div>,
    );
    expect(spy.mock.calls.map(([c]) => c.client_id).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    spy.mockClear();

    act(() => {
      useDawStore
        .getState()
        .applyPresenceDelta("a", { meta: { display_name: "A2" } }, 5);
    });

    expect(spy.mock.calls.map(([c]) => c.client_id)).toEqual(["a"]);
  });
});
