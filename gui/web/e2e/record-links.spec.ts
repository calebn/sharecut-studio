import { type Browser, expect, test } from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
import { withShareableProject } from "./shareableProject";

test.describe("record links", () => {
  test("guest and producer stub lobbies, prefix mismatch 404", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      const hostCtx = await browser.newContext();
      const aCtx = await browser.newContext();
      const bCtx = await browser.newContext();
      const host = await hostCtx.newPage();
      const pageA = await aCtx.newPage();
      const pageB = await bCtx.newPage();
      try {
        const project = encodeURIComponent(projectPath);
        await host.goto(`/?project=${project}`);
        const created = await host.request.post("/api/shares/record", {
          data: { path: projectPath },
        });
        expect(created.ok(), await created.text()).toBeTruthy();
        const room = (await created.json()) as {
          room: {
            session_id: string;
            guest: { token: string };
            producer: { token: string };
          };
        };
        const guest = room.room.guest.token;
        const producer = room.room.producer.token;

        await pageB.addInitScript(() => {
          Object.defineProperty(window, "__gumCalled", {
            value: false,
            writable: true,
          });
          const md = navigator.mediaDevices;
          if (md) {
            md.getUserMedia = async () => {
              (window as unknown as { __gumCalled: boolean }).__gumCalled =
                true;
              throw new Error("getUserMedia should not be called");
            };
          }
        });
        await pageA.goto(`/rec/${guest}`);
        await expect(
          pageA.getByRole("heading", { name: "Join the recording" }),
        ).toBeVisible();
        await expect(pageA.locator(".daw-shell")).toHaveCount(0);
        await expect(pageA.locator(".review-compose")).toHaveCount(0);

        await pageB.goto(`/rec/${producer}`);
        await expect(
          pageB.getByRole("heading", { name: "Producer — not recorded" }),
        ).toBeVisible();
        await expect(
          pageB.getByRole("heading", { name: "Not recorded", exact: true }),
        ).toBeVisible();
        await expect(pageB.locator(".daw-shell")).toHaveCount(0);
        expect(
          await pageB.evaluate(
            () => (window as unknown as { __gumCalled?: boolean }).__gumCalled,
          ),
        ).toBe(false);

        const recAsReview = await pageA.request.get(`/r/${guest}`);
        expect(recAsReview.status()).toBe(404);

        const reviewShare = await host.request.post("/api/shares", {
          data: { path: projectPath, role: "viewer" },
        });
        expect(reviewShare.ok(), await reviewShare.text()).toBeTruthy();
        const reviewBody = (await reviewShare.json()) as {
          share: { token: string };
        };
        const reviewAsRec = await pageA.request.get(
          `/rec/${reviewBody.share.token}`,
        );
        expect(reviewAsRec.status()).toBe(404);

        await expectReadingSurfaceAxeClean(pageA);
        await expectReadingSurfaceAxeClean(pageB);

        await pageA.goto(`/r/${guest}`);
        await expect(pageA.locator("body")).toContainText(/not found|404/i);

        const ended = await host.request.post(
          `/api/shares/rooms/${room.room.session_id}/revoke`,
          { data: { path: projectPath } },
        );
        expect(ended.ok(), await ended.text()).toBeTruthy();
      } finally {
        await hostCtx.close();
        await aCtx.close();
        await bCtx.close();
      }
    });
  });
});
