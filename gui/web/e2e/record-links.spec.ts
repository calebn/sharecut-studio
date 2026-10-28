import { type Browser, expect, test } from "@playwright/test";
import { expectSurfaceAxeClean } from "./axe";
import { createRecordRoom, joinNameField } from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { createReviewShare } from "./shareNavigation";
import { withBrowserPages } from "./twoBrowserPages";

test.describe("record links", () => {
  test("guest and producer stub lobbies, prefix mismatch 404", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [{}, {}, {}],
        async ([host, pageA, pageB]) => {
          const project = encodeURIComponent(projectPath);
          await host.goto(`/?project=${project}`);
          const room = await createRecordRoom(host, projectPath);
          const guest = room.guest.token;
          const producer = room.producer.token;

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
          await expect(pageA.getByRole("dialog")).toBeVisible();
          await expect(joinNameField(pageA)).toBeVisible();
          await expect(
            pageA.getByRole("button", { name: "Allow microphone" }),
          ).toBeVisible();
          await expect(
            pageA.getByRole("button", { name: "Join and record" }),
          ).toBeVisible();
          await expect(pageA.getByRole("heading", { level: 1 })).toHaveCount(1);
          await expect(pageA.getByRole("main")).toHaveCount(1);
          await expect(pageA.locator(".stage-frame")).toHaveCount(0);

          await pageB.goto(`/rec/${producer}`);
          await expect(pageB.getByRole("dialog")).toBeVisible();
          await expect(joinNameField(pageB)).toBeVisible();
          await expect(
            pageB.getByRole("button", { name: "Join to listen" }),
          ).toBeVisible();
          await expect(pageB.getByText("You won't be recorded.")).toBeVisible();
          await expect(
            pageB.getByRole("button", { name: "Allow microphone" }),
          ).toHaveCount(0);
          await expect(pageB.locator(".stage-frame")).toHaveCount(0);
          expect(
            await pageB.evaluate(
              () =>
                (window as unknown as { __gumCalled?: boolean }).__gumCalled,
            ),
          ).toBe(false);

          const recAsReview = await pageA.request.get(`/r/${guest}`);
          expect(recAsReview.status()).toBe(200);

          const reviewToken = await createReviewShare(host, projectPath);
          const reviewAsRec = await pageA.request.get(`/rec/${reviewToken}`);
          expect(reviewAsRec.status()).toBe(200);

          await expectSurfaceAxeClean(pageA, "body");
          await expectSurfaceAxeClean(pageB, "body");

          await pageA.goto(`/r/${guest}`);
          await expect(pageA.locator("body")).toContainText(
            "This link is invalid or has ended.",
          );
          await expect(pageA.locator("body")).toContainText(
            "Ask the host for a new link.",
          );

          const ended = await host.request.post(
            `/api/shares/rooms/${room.session_id}/revoke`,
            { data: { path: projectPath } },
          );
          expect(ended.ok(), await ended.text()).toBeTruthy();
        },
      );
    });
  });
});
