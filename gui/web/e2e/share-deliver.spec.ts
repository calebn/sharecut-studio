import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { createRecordRoom } from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { createReviewShare } from "./shareNavigation";
import {
  deliverPage,
  goToStage,
  openProject,
  openProjectDialog,
} from "./stageNav";

type Row = {
  token: string;
  url: string | null;
  docs_role: string | null;
  mcp_url: string | null;
  follow_latest?: boolean;
  usable: boolean;
  session_id?: string | null;
};

test.use({
  viewport: { width: 1280, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});

function share(page: Page): Locator {
  return deliverPage(page).getByRole("region", { name: "Share" });
}

async function openShare(page: Page, projectPath: string): Promise<Locator> {
  await openProject(page, projectPath);
  await goToStage(page, "deliver");
  const section = share(page);
  await expect(section).toBeVisible();
  await expect(section.getByText("Looking for your links…")).toBeHidden();
  return section;
}

async function rows(page: Page, projectPath: string): Promise<Row[]> {
  const res = await page.request.get(
    `/api/shares?path=${encodeURIComponent(projectPath)}`,
  );
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { shares: Row[] }).shares;
}

const clipboard = (page: Page) =>
  page.evaluate(() => navigator.clipboard.readText());

function tunnel(state: string, extra: Record<string, unknown> = {}) {
  return {
    state,
    reason: null,
    reason_kind: null,
    relay_host: "relay.example.test",
    public_base_url: "https://share.example.test",
    share_count: 1,
    retry_at: null,
    ...extra,
  };
}

test.describe("Share on Deliver", () => {
  test("Create review link makes the link and copies it, and Copy on its row copies it again", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      const section = await openShare(page, projectPath);
      await expect(section.getByText("No review links yet.")).toBeVisible();
      await expect(
        section.getByRole("button", { name: "Commenter" }),
      ).toHaveAttribute("aria-pressed", "true");

      await section.getByRole("button", { name: "Create review link" }).click();
      await expect(
        section.getByRole("button", { name: "Copied Commenter link" }),
      ).toBeVisible();
      const [made] = await rows(page, projectPath);
      expect(made.docs_role).toBe("commenter");
      expect(made.mcp_url).toBeNull();
      expect(made.follow_latest).toBe(true);
      expect(await clipboard(page)).toBe(made.url);
      await expect(section.getByText(made.token)).toBeVisible();
      await expect(
        section.getByText("Review link created and copied"),
      ).toBeVisible();

      await page.evaluate(() => navigator.clipboard.writeText("elsewhere"));
      await expect(
        section.getByRole("button", { name: "Copy Commenter link" }),
      ).toBeVisible();
      await section
        .getByRole("button", { name: "Copy Commenter link" })
        .click();
      expect(await clipboard(page)).toBe(made.url);
      await expectPageAxeClean(page, ".dv-stage");
    });
  });

  test("the role, MCP and Freeze choices reach the link", async ({ page }) => {
    await withShareableProject(async (projectPath) => {
      const section = await openShare(page, projectPath);
      await section.getByRole("button", { name: "Editor" }).click();
      await section
        .getByRole("button", { name: "Allow AI assistants (MCP)" })
        .click();
      await section
        .getByRole("button", { name: "Freeze on the current version" })
        .click();
      await section.getByRole("button", { name: "Create review link" }).click();
      await expect(
        section
          .getByRole("button", { name: "Copy Editor link" })
          .or(section.getByRole("button", { name: "Copied Editor link" })),
      ).toBeVisible();
      const [made] = await rows(page, projectPath);
      expect(made.docs_role).toBe("editor");
      expect(made.mcp_url).toBeTruthy();
      expect(made.follow_latest).toBe(false);
      await expect(section.getByText(/Frozen on /)).toBeVisible();
      await expect(section.getByText(/AI assistants allowed/)).toBeVisible();
      await section.getByRole("button", { name: "Copy MCP URL" }).click();
      await expect(
        section.getByRole("button", { name: "Copied MCP URL" }),
      ).toBeVisible();
      expect(await clipboard(page)).toBe(made.mcp_url);
    });
  });

  test("Stop sharing confirms in place, keeps the link on Keep, and turns it off on confirm", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const token = await createReviewShare(page, projectPath, "viewer");
      const nativeDialogs: string[] = [];
      page.on("dialog", (native) => {
        nativeDialogs.push(native.message());
        void native.dismiss();
      });
      const section = await openShare(page, projectPath);
      const stop = section.getByRole("button", { name: "Stop sharing" });
      await stop.click();
      const confirm = section.getByRole("group", {
        name: "Stop sharing this Viewer link? Anyone using it loses access.",
      });
      await expect(confirm).toBeVisible();
      await expect(
        confirm.getByRole("button", { name: "Keep link" }),
      ).toBeFocused();
      await expectPageAxeClean(page, ".dv-stage");

      await page.keyboard.press("Escape");
      await expect(confirm).toBeHidden();
      await expect(stop).toBeFocused();
      expect(
        (await rows(page, projectPath)).find((r) => r.token === token)?.usable,
      ).toBe(true);

      await stop.click();
      await confirm.getByRole("button", { name: "Keep link" }).click();
      await expect(stop).toBeFocused();

      await stop.click();
      await confirm.getByRole("button", { name: "Stop sharing" }).click();
      await expect(section.getByText("No review links yet.")).toBeVisible();
      await expect(
        section.getByRole("heading", { name: "Review links" }),
      ).toBeFocused();
      await expect(
        section.getByText("Stopped sharing the Viewer link"),
      ).toBeVisible();
      expect((await rows(page, projectPath)).filter((r) => r.usable)).toEqual(
        [],
      );
      expect(nativeDialogs).toEqual([]);
    });
  });

  test("online sharing shows each state, and a link only this network can open says so", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      await createReviewShare(page, projectPath, "commenter");
      let current = tunnel("off");
      await page.route("**/api/tunnel/status", (route) =>
        route.fulfill({ json: current }),
      );
      const section = await openShare(page, projectPath);
      const reach =
        "Only people on this network can listen. Turn on online sharing to reach anyone.";
      await expect(section.getByText("Online sharing is off")).toBeVisible();
      await expect(section.getByText(reach)).toBeVisible();

      current = tunnel("online");
      await expect(
        section.getByText("Guests can open your links"),
      ).toBeVisible();
      await expect(section.getByText(reach)).toBeHidden();

      current = tunnel("reconnecting", {
        reason_kind: "network",
        retry_at: Date.now() / 1000 + 30,
      });
      await expect(section.getByText(/^Reconnecting…/)).toBeVisible();
      await expect(section.getByText(/Trying again|Next try at/)).toBeVisible();

      current = tunnel("offline", { reason_kind: "auth" });
      await expect(section.getByText(/^Not reachable online/)).toBeVisible();
      await section.getByText("How to fix").click();
      await expect(
        section.getByRole("link", { name: /Online sharing guide/ }),
      ).toBeVisible();
      await expectPageAxeClean(page, ".dv-stage");
    });
  });

  test("polls online sharing only while Deliver shows", async ({ page }) => {
    await withShareableProject(async (projectPath) => {
      let polls = 0;
      await page.route("**/api/tunnel/status", (route) => {
        polls += 1;
        return route.fulfill({ json: tunnel("online") });
      });
      const section = await openShare(page, projectPath);
      await expect(
        section.getByText("Guests can open your links"),
      ).toBeVisible();
      await goToStage(page, "edit");
      const left = polls;
      await page.waitForTimeout(6_000);
      expect(polls).toBe(left);
    });
  });

  for (const refusal of ["no_mix", "stale_mix"] as const) {
    test(`a ${refusal} refusal offers Refresh mix, then makes the link once`, async ({
      page,
    }) => {
      await withShareableProject(async (projectPath) => {
        const section = await openShare(page, projectPath);
        let refuse = true;
        await page.route("**/api/shares", async (route) => {
          if (route.request().method() === "POST" && refuse) {
            await route.fulfill({
              status: 409,
              headers: { "X-Sharecut-Error-Code": refusal },
              json: {
                detail: "premix.wav is stale; render-preview provenance",
              },
            });
            return;
          }
          await route.fallback();
        });
        await section
          .getByRole("button", { name: "Create review link" })
          .click();
        await expect(section.getByRole("alert")).toContainText(
          refusal === "no_mix"
            ? "This project has no mix yet. Refresh the mix to create the link."
            : "The mix preview is out of date. Refresh it before creating a review link.",
        );
        await expect(section).not.toContainText("premix.wav");
        expect(await rows(page, projectPath)).toEqual([]);

        refuse = false;
        await section.getByRole("button", { name: "Refresh mix" }).click();
        await expect(
          section.getByRole("button", { name: /Commenter link$/ }),
        ).toBeVisible({ timeout: 60_000 });
        expect(await rows(page, projectPath)).toHaveLength(1);
        await expect(
          section.getByRole("button", { name: "Refresh mix" }),
        ).toBeHidden();
      });
    });
  }

  test("a stale_master refusal asks for a new master and offers no Refresh mix", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      const section = await openShare(page, projectPath);
      await page.route("**/api/shares", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 409,
            headers: { "X-Sharecut-Error-Code": "stale_master" },
            json: { detail: "master_loudness provenance mismatch" },
          });
          return;
        }
        await route.fallback();
      });
      await section.getByRole("button", { name: "Create review link" }).click();
      await expect(section.getByRole("alert")).toHaveText(
        "The mastered mix is out of date. Export a new master before creating a review link.",
      );
      await expect(
        section.getByRole("button", { name: "Refresh mix" }),
      ).toHaveCount(0);
      await expect(section).not.toContainText("master_loudness");
    });
  });

  test("record rooms: create, copy the guest link, and end the room after the confirm", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      const section = await openShare(page, projectPath);
      await expect(section.getByText("No record rooms yet.")).toBeVisible();
      await section
        .getByRole("button", { name: "Create record links" })
        .click();
      await expect(
        section.getByText("Guest link", { exact: true }),
      ).toBeVisible();
      await expect(
        section.getByText("Producer link", { exact: true }),
      ).toBeVisible();
      await expect(
        section.getByRole("button", { name: "Copied guest link" }),
      ).toBeVisible();
      const room = (await rows(page, projectPath)).find(
        (r) => r.session_id && r.docs_role === null,
      );
      expect(room).toBeTruthy();

      await section.getByRole("button", { name: "End room" }).click();
      const confirm = section.getByRole("group", {
        name: "End this record room? Both guest and producer links will stop working.",
      });
      await expect(
        confirm.getByRole("button", { name: "Keep room" }),
      ).toBeFocused();
      await confirm.getByRole("button", { name: "End room" }).click();
      await expect(section.getByText("No record rooms yet.")).toBeVisible();
      expect((await rows(page, projectPath)).filter((r) => r.usable)).toEqual(
        [],
      );
    });
  });

  test("a room made elsewhere is listed, and Open Record stage goes there", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      await createRecordRoom(page, projectPath);
      const section = await openShare(page, projectPath);
      await expect(
        section.getByText("Record room", { exact: true }),
      ).toBeVisible();
      await section.getByRole("button", { name: "Open Record stage" }).click();
      await expect(page.getByRole("tab", { name: /Record/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  test("the Share a listen link button focuses the section, and the header Invite still opens the dialog", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      const section = await openShare(page, projectPath);
      await page.getByRole("button", { name: "Share a listen link" }).click();
      await expect(
        section.getByRole("button", { name: "Create review link" }),
      ).toBeFocused();
      await expect(page.getByRole("dialog", { name: "Share" })).toBeHidden();

      await openProjectDialog(page, "share");
      await expect(
        page.getByRole("dialog", { name: "Share", exact: true }),
      ).toBeVisible();
    });
  });
});
