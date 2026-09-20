import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPresenceThrottle } from "./publisher";

describe("createPresenceThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the first cursor immediately then throttles", () => {
    const sent: unknown[] = [];
    const t = createPresenceThrottle({ cursorMs: 100 });
    t.onSend((meta) => sent.push(meta));
    t.push({ cursor: { t_sec: 1 } });
    expect(sent).toHaveLength(1);
    t.push({ cursor: { t_sec: 2 } });
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(sent.at(-1)).toEqual({ cursor: { t_sec: 2 } });
  });

  it("flushes cursor null and following changes immediately", () => {
    const sent: unknown[] = [];
    const t = createPresenceThrottle();
    t.onSend((meta) => sent.push(meta));
    t.push({ cursor: null });
    t.push({ following: "a" });
    t.push({ following: "b" });
    expect(sent).toEqual([
      { cursor: null },
      { following: "a" },
      { following: "b" },
    ]);
  });

  it("flushes following with copied presence cleared in the same frame", () => {
    const sent: unknown[] = [];
    const t = createPresenceThrottle();
    t.onSend((meta) => sent.push(meta));
    t.push({
      following: "host",
      transport: null,
      viewport: null,
    });
    expect(sent).toEqual([
      { following: "host", transport: null, viewport: null },
    ]);
  });

  it("drops a pending flush after dispose", () => {
    const sent: unknown[] = [];
    const t = createPresenceThrottle({ cursorMs: 100 });
    t.onSend((meta) => sent.push(meta));
    t.push({ cursor: { t_sec: 1 } });
    t.push({ cursor: { t_sec: 2 } });
    t.dispose();
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([{ cursor: { t_sec: 1 } }]);
  });

  it("throttles ui at 100ms but flushes tab changes immediately", () => {
    const sent: unknown[] = [];
    const t = createPresenceThrottle({ uiMs: 100 });
    t.onSend((meta) => sent.push(meta));
    t.push({
      ui: { tab: "transcript", audition: "mix", transcript_anchor: "a" },
    });
    expect(sent).toHaveLength(1);
    t.push({
      ui: { tab: "transcript", audition: "mix", transcript_anchor: "b" },
    });
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(sent.at(-1)).toEqual({
      ui: { tab: "transcript", audition: "mix", transcript_anchor: "b" },
    });
    t.push({
      ui: { tab: "comments", audition: "mix", transcript_anchor: "b" },
    });
    expect(sent.at(-1)).toEqual({
      ui: { tab: "comments", audition: "mix", transcript_anchor: "b" },
    });
  });
});
