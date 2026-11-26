import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hostWithResponse } from "./hostRequestFakes";
import { createReviewShare, openGuestShare } from "./shareNavigation";

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

  it("removes the review timeline beside the project unless the share is frozen", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-nav-"));
    try {
      const projectPath = path.join(dir, "project.json");
      const timeline = path.join(
        dir,
        "artifacts",
        "review",
        "v1",
        "timeline.json",
      );
      fs.mkdirSync(path.dirname(timeline), { recursive: true });
      fs.writeFileSync(timeline, "{}");

      const { page } = hostWithResponse(true, { share: { token: "t" } });
      await createReviewShare(page as never, projectPath, "viewer", {
        frozen: true,
      });
      expect(fs.existsSync(timeline)).toBe(true);

      await createReviewShare(page as never, projectPath);
      expect(fs.existsSync(timeline)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
