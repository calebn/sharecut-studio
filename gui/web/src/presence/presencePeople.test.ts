import { describe, expect, it } from "vitest";
import type { SessionClient } from "../types/session";
import { presencePeople } from "./presencePeople";

const NOW = 1_000_000;
const client = (over: Partial<SessionClient> = {}): SessionClient => ({
  client_id: "maya",
  role: "editor",
  ...over,
});

describe("presencePeople", () => {
  it("names a client from its display name, then its label, then its id", () => {
    const [a, b, c] = presencePeople(
      [
        client({ label: "Label", meta: { display_name: "Maya Okafor" } }),
        client({ client_id: "b", label: "Anneke" }),
        client({ client_id: "c" }),
      ],
      600,
      NOW,
    );
    expect([a.name, b.name, c.name]).toEqual(["Maya Okafor", "Anneke", "c"]);
  });

  it("takes the colour from meta and the first colour when there is none", () => {
    const [a, b] = presencePeople(
      [
        client({ meta: { color_index: 5 } }),
        client({ client_id: "b", meta: {} }),
      ],
      600,
      NOW,
    );
    expect([a.colorIndex, b.colorIndex]).toEqual([5, 0]);
  });

  it("prefers a stamped transport, advanced to now, over the top-level playhead", () => {
    const [person] = presencePeople(
      [
        client({
          playhead_sec: 99,
          meta: {
            transport: {
              playing: true,
              playhead_sec: 10,
              rate: 1,
              stamped_ns: (NOW - 2000) * 1e6,
            },
          },
        }),
      ],
      600,
      NOW,
    );
    expect(person.playhead).toBe(12);
  });

  it("prefers an unstamped transport's playhead over the top-level one", () => {
    const [person] = presencePeople(
      [
        client({
          playhead_sec: 99,
          meta: { transport: { playing: false, playhead_sec: 40, rate: 1 } },
        }),
      ],
      600,
      NOW,
    );
    expect(person.playhead).toBe(40);
  });

  it("falls back to the top-level playhead, held to the episode", () => {
    const people = presencePeople(
      [
        client({ playhead_sec: 25.5 }),
        client({ client_id: "late", playhead_sec: 9000 }),
      ],
      600,
      NOW,
    );
    expect(people.map((p) => p.playhead)).toEqual([25.5, 600]);
  });

  it("has no playhead for a client that reports none", () => {
    const [person] = presencePeople([client()], 600, NOW);
    expect("playhead" in person).toBe(false);
  });

  it("has no playhead for a client who follows someone", () => {
    const [person] = presencePeople(
      [client({ playhead_sec: 25, meta: { following: "anneke" } })],
      600,
      NOW,
    );
    expect("playhead" in person).toBe(false);
  });
});
