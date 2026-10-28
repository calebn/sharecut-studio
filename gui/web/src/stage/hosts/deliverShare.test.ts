import { describe, expect, it, vi } from "vitest";
import { ONLINE, REVIEW_ROW } from "../../stages/deliver/shareFixture";
import { shareOptionsOf } from "./deliverShare";
import type { ShareFlow } from "./shareFlow";

function flow(over: Partial<ShareFlow> = {}): ShareFlow {
  return {
    role: "editor",
    setRole: vi.fn(),
    withMcp: true,
    setWithMcp: vi.fn(),
    freeze: true,
    setFreeze: vi.fn(),
    rows: [REVIEW_ROW],
    busy: true,
    createRecovery: { kind: "refreshing" },
    error: "boom",
    status: "done",
    copiedKey: "link:sample-review-link",
    lastCreated: { token: "t", url: "u", kind: "review" },
    tunnel: ONLINE,
    create: vi.fn(),
    refreshMix: vi.fn(),
    createRecord: vi.fn(),
    copy: vi.fn(),
    revoke: vi.fn(),
    endRoom: vi.fn(),
    replaceRecordInvite: vi.fn(),
    openRoomPanel: vi.fn(),
    ...over,
  };
}

const request = { focusRequested: true, onFocused: vi.fn() };

describe("shareOptionsOf", () => {
  it("hands the flow's choices, rows and feedback to the stage as they are", () => {
    const f = flow();
    const options = shareOptionsOf(f, request);
    expect(options).toEqual({
      role: "editor",
      onRole: f.setRole,
      withMcp: true,
      onWithMcp: f.setWithMcp,
      freeze: true,
      onFreeze: f.setFreeze,
      rows: [REVIEW_ROW],
      busy: true,
      createRecovery: { kind: "refreshing" },
      error: "boom",
      status: "done",
      copiedKey: "link:sample-review-link",
      lastCreated: { token: "t", url: "u", kind: "review" },
      tunnel: ONLINE,
      reach: "anywhere",
      onCreate: f.create,
      onRefreshMix: f.refreshMix,
      onCreateRecord: f.createRecord,
      onCopy: f.copy,
      onRevoke: f.revoke,
      onEndRoom: f.endRoom,
      onReplaceRecordInvite: f.replaceRecordInvite,
      onOpenRoomPanel: f.openRoomPanel,
      focusRequested: true,
      onFocused: request.onFocused,
    });
  });

  it("says the links reach this network only while online sharing is off", () => {
    expect(
      shareOptionsOf(flow({ tunnel: { ...ONLINE, state: "off" } }), request)
        .reach,
    ).toBe("network");
  });

  it("says nothing about reach while the online sharing state is unknown", () => {
    expect(
      shareOptionsOf(flow({ tunnel: null }), request).reach,
    ).toBeUndefined();
  });
});
