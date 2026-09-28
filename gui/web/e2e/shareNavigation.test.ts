import { describe, expect, it, vi } from "vitest";
import { createReviewShare, openGuestShare } from "./shareNavigation";

function hostWithResponse(ok: boolean, body: unknown) {
  const post = vi.fn(async () => ({
    ok: () => ok,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }));
  return { page: { request: { post } }, post };
}

describe("createReviewShare", () => {
  it("posts the project path and default viewer role, returning the token", async () => {
    const { page, post } = hostWithResponse(true, {
      share: { token: "tok-1" },
    });
    await expect(createReviewShare(page as never, "/p/x.json")).resolves.toBe(
      "tok-1",
    );
    expect(post).toHaveBeenCalledWith("/api/shares", {
      data: { path: "/p/x.json", role: "viewer" },
    });
  });

  it("posts an explicit editor role", async () => {
    const { page, post } = hostWithResponse(true, {
      share: { token: "tok-2" },
    });
    await createReviewShare(page as never, "/p/x.json", "editor");
    expect(post).toHaveBeenCalledWith("/api/shares", {
      data: { path: "/p/x.json", role: "editor" },
    });
  });

  it("rejects with the server body when the share is refused", async () => {
    const { page } = hostWithResponse(false, { detail: "no project" });
    await expect(createReviewShare(page as never, "/p/x.json")).rejects.toThrow(
      /no project/,
    );
  });
});

it("preserves navigation failure while observing a failed manifest wait", async () => {
  const navigationError = new Error("navigation failed");
  const manifestError = new Error("manifest wait failed");
  let rejectManifest!: (error: Error) => void;
  const page = {
    waitForResponse: () =>
      new Promise<never>((_, reject) => {
        rejectManifest = reject;
      }),
    goto: async () => {
      throw navigationError;
    },
  };

  await expect(openGuestShare(page as never, "token")).rejects.toBe(
    navigationError,
  );
  rejectManifest(manifestError);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});
