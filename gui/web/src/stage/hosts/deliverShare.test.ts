import { describe, expect, it, vi } from "vitest";
import { SHARE_DEFAULTS } from "../../stages/deliver/shareLogic";
import { hostShareRow } from "../../test/fixtures";
import type { TunnelStatus } from "../../types/tunnel";
import { shareOptionsOf } from "./deliverShare";
import type { ShareFlow } from "./shareFlowContext";

function flow(over: Partial<ShareFlow> = {}): ShareFlow {
  return {
    rows: [hostShareRow()],
    loaded: true,
    choices: SHARE_DEFAULTS,
    setChoices: vi.fn(),
    busy: false,
    recovery: { kind: "idle" },
    error: null,
    status: null,
    copiedKey: null,
    blockedKey: null,
    reload: vi.fn(),
    create: vi.fn(),
    refreshMix: vi.fn(),
    copy: vi.fn(),
    stop: vi.fn(),
    createRecord: vi.fn(),
    replaceInvite: vi.fn(),
    endRoom: vi.fn(),
    ...over,
  };
}

const host = () => ({
  tunnel: null as TunnelStatus | null,
  onOpenRecord: vi.fn(),
  focusRequested: false,
  onFocused: vi.fn(),
});

describe("shareOptionsOf", () => {
  it("hands the flow's state and actions to the stage as they are", () => {
    const f = flow({
      busy: true,
      error: "Boom",
      status: "Done",
      copiedKey: "link:a",
      blockedKey: "link:b",
      recovery: { kind: "refreshing" },
      choices: { role: "editor", withMcp: true, freeze: true },
    });
    const o = shareOptionsOf(f, host());
    expect(o).toMatchObject({
      rows: f.rows,
      loaded: true,
      busy: true,
      error: "Boom",
      status: "Done",
      copiedKey: "link:a",
      blockedKey: "link:b",
      recovery: { kind: "refreshing" },
      choices: { role: "editor", withMcp: true, freeze: true },
    });
    expect(o.onChoices).toBe(f.setChoices);
    expect(o.onCreate).toBe(f.create);
    expect(o.onRefreshMix).toBe(f.refreshMix);
    expect(o.onCopy).toBe(f.copy);
    expect(o.onStop).toBe(f.stop);
    expect(o.onCreateRecord).toBe(f.createRecord);
    expect(o.onReplaceInvite).toBe(f.replaceInvite);
    expect(o.onEndRoom).toBe(f.endRoom);
  });

  it("adds what only the host knows: online sharing, why Share is blocked, the Record stage and focus", () => {
    const tunnel: TunnelStatus = {
      state: "online",
      reason: null,
      reason_kind: null,
      relay_host: null,
      public_base_url: null,
      share_count: null,
      retry_at: null,
    };
    const h = { ...host(), tunnel, blockedReason: "Open a project first." };
    const o = shareOptionsOf(flow(), { ...h, focusRequested: true });
    expect(o.tunnel).toBe(tunnel);
    expect(o.blockedReason).toBe("Open a project first.");
    expect(o.onOpenRecord).toBe(h.onOpenRecord);
    expect(o.focusRequested).toBe(true);
    expect(o.onFocused).toBe(h.onFocused);
  });

  it("has no tunnel without the feature", () => {
    expect(shareOptionsOf(flow(), host()).tunnel).toBeNull();
  });
});
