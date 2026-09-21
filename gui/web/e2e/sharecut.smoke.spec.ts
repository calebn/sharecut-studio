import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test.describe("Sharecut Studio smoke", () => {
  test("loads fixture project shell and is axe-clean on chrome", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);

    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(
      page
        .getByLabel("Editor panels")
        .getByRole("button", { name: "Transcript", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByLabel("Editor panels")
        .getByRole("button", { name: "Comments" }),
    ).toBeVisible();
    await expect(page.locator(".daw-shell")).toBeVisible();

    await expectPageAxeClean(page);
  });

  test("opens the host Tighten panel (aligned_dialogue has no filler hits)", async ({
    page,
  }) => {
    // aligned_dialogue ships empty editorial.edit_decisions — no fixture helper
    // seeds filler:/pause: pending rows, so this is open + empty-state only.
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const panels = page.getByLabel("Editor panels");
    await panels.getByRole("button", { name: "Tighten", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Tighten" })).toBeVisible();
    await expect(
      page.getByText("No pending filler or pause decisions."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Apply eligible/ }),
    ).toBeDisabled();
  });

  test("shows a queued host comment without a false submission error", async ({
    page,
  }) => {
    const commands: Array<{
      command_id: string;
      client_id: string;
      client_seq: number;
      type: string;
    }> = [];
    let rejectAddComment = true;
    await page.route("**/api/document/command?*", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const command = route
        .request()
        .postDataJSON() as (typeof commands)[number];
      if (command.type !== "AddComment") {
        await route.continue();
        return;
      }
      commands.push(command);
      if (rejectAddComment) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await page
      .getByLabel("Editor panels")
      .getByRole("button", {
        name: "Comments",
      })
      .click();
    await page.getByRole("button", { name: "Comment mode" }).click();
    await page.getByRole("slider", { name: "Comment time anchor" }).click();
    await page.getByLabel("Author").fill("Host");
    await page.getByPlaceholder("Feedback…").fill("Queued review note");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(() => commands.length).toBe(1);
    await expect
      .poll(async () =>
        page.evaluate(async (projectPath) => {
          return new Promise<number>((resolve, reject) => {
            const open = indexedDB.open("podcast-daw-offline", 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const request = db
                .transaction("kv", "readonly")
                .objectStore("kv")
                .get(`host-queue:${projectPath}`);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                db.close();
                resolve((request.result as unknown[] | undefined)?.length ?? 0);
              };
            };
          });
        }, e2eProjectPath),
      )
      .toBe(1);
    await expect(page.getByRole("alert")).toContainText("1 pending");
    await expect(
      page.getByText("AddComment did not return a comment"),
    ).toHaveCount(0);
    await expect(page.getByPlaceholder("Feedback…")).toHaveValue("");

    rejectAddComment = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]).toMatchObject({
      command_id: commands[0]?.command_id,
      client_id: commands[0]?.client_id,
      client_seq: commands[0]?.client_seq,
      type: "AddComment",
    });
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
