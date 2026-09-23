import { describe, expect, it, vi } from "vitest";
import {
  createRecordRoom,
  markSharecutE2e,
  openRecordLink,
  recordLinkPath,
} from "./recordRoom";

const room = {
  session_id: "sess-1",
  guest: { token: "guest-token" },
  producer: { token: "producer-token" },
};

function hostWithResponse(ok: boolean, body: unknown) {
  const post = vi.fn(async () => ({
    ok: () => ok,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }));
  return { page: { request: { post } }, post };
}

describe("createRecordRoom", () => {
  it("posts the project path and returns the room", async () => {
    const { page, post } = hostWithResponse(true, { room });
    await expect(createRecordRoom(page as never, "/p/x.json")).resolves.toEqual(
      room,
    );
    expect(post).toHaveBeenCalledWith("/api/shares/record", {
      data: { path: "/p/x.json" },
    });
  });

  it("fails with the server body when the share is rejected", async () => {
    const { page } = hostWithResponse(false, { detail: "no project" });
    await expect(createRecordRoom(page as never, "/p/x.json")).rejects.toThrow(
      /no project/,
    );
  });
});

describe("record links", () => {
  it("builds an E2E-enabled record link and navigates to it", async () => {
    expect(recordLinkPath("a b")).toBe("/rec/a%20b?e2e=1");
    const goto = vi.fn(async () => null);
    await openRecordLink({ goto } as never, "guest-token");
    expect(goto).toHaveBeenCalledWith("/rec/guest-token?e2e=1");
  });
});

describe("markSharecutE2e", () => {
  it("sets the E2E window flag before page scripts run", async () => {
    const addInitScript = vi.fn(async (script: () => void) => script());
    const target = window as unknown as { __SHARECUT_E2E?: boolean };
    delete target.__SHARECUT_E2E;
    await markSharecutE2e({ addInitScript } as never);
    expect(target.__SHARECUT_E2E).toBe(true);
    delete target.__SHARECUT_E2E;
  });
});
