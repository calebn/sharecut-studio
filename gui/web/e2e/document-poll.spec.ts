import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

/**
 * One host document command should reach the timeline as exactly one socket
 * Applied frame, with no `/api/project` GET from the sanity poll skipping in
 * behind it (#657). The sanity poll ticks every 30 s (`SANITY_POLL_MS`,
 * #662), so this forces one meta check with a focus event instead of waiting
 * out the interval.
 */
test.describe("Document poll double-apply", () => {
  test("a host commit is one socket frame and no project GET", async ({
    page,
  }) => {
    let sawHelloSnapshot = false;
    const appliedFrames: unknown[] = [];

    page.on("websocket", (ws) => {
      if (!ws.url().includes("/api/document/ws")) {
        return;
      }
      ws.on("framereceived", (event) => {
        let msg: { type?: string } | null = null;
        try {
          msg = JSON.parse(String(event.payload));
        } catch {
          return;
        }
        if (msg?.type === "Snapshot") {
          sawHelloSnapshot = true;
        } else if (msg?.type === "Applied") {
          appliedFrames.push(msg);
        }
      });
    });

    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await expect.poll(() => sawHelloSnapshot).toBe(true);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Confirm the fixture's second track's label starts (and will end) as
    // its own id, so the finally-block restore below is correct.
    const trackId = "guest";
    const originalLabel = "guest";

    // Narrowed to `phase=shell`: a legitimate `?phase=detail` transcript
    // hydrate can follow a TRACKS patch (word overlay refetch) and is not
    // part of the double-apply this test guards against.
    const shellGets: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (
        url.pathname === "/api/project" &&
        url.searchParams.get("phase") === "shell"
      ) {
        shellGets.push(req.url());
      }
    });
    appliedFrames.length = 0;

    let restored = false;
    try {
      const res = await page.request.post(
        `/api/document/command?path=${encodeURIComponent(e2eProjectPath)}`,
        {
          data: {
            type: "SetTrackMeta",
            payload: { track_id: trackId, label: "guest e2e poll" },
            client_id: "e2e-document-poll",
            role: "viewer",
          },
        },
      );
      expect(res.ok()).toBe(true);

      await expect.poll(() => appliedFrames.length).toBe(1);
      // The sanity poll ticks every 30 s; a focus event runs one meta check
      // now (#662), giving it a chance to (wrongly) fetch a second time.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(1500);

      expect(appliedFrames).toHaveLength(1);
      expect(shellGets).toEqual([]);
    } finally {
      const restoreRes = await page.request.post(
        `/api/document/command?path=${encodeURIComponent(e2eProjectPath)}`,
        {
          data: {
            type: "SetTrackMeta",
            payload: { track_id: trackId, label: originalLabel },
            client_id: "e2e-document-poll",
            role: "viewer",
          },
        },
      );
      restored = restoreRes.ok();
    }
    expect(restored).toBe(true);
  });
});
