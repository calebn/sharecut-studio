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

// Matches TUNNEL_STATUS_POLL_MS in src/stage/hosts/useTunnelStatus.ts.
const TUNNEL_POLL_MS = 5_000;

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

/** The Invite sheet, opened from the header's Invite on `stage`. */
async function openInvite(
  page: Page,
  projectPath: string,
  stage: "edit" | "deliver" = "edit",
): Promise<Locator> {
  await openProject(page, projectPath);
  await goToStage(page, stage);
  await openProjectDialog(page, "share");
  const sheet = page.getByRole("dialog", { name: "Invite" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Looking for your links…")).toBeHidden();
  return sheet;
}

/** The Listen link region on Deliver. */
async function openListen(page: Page, projectPath: string): Promise<Locator> {
  await openProject(page, projectPath);
  await goToStage(page, "deliver");
  const region = deliverPage(page).getByRole("region", {
    name: "Listen link",
  });
  await expect(region).toBeVisible();
  await expect(region.getByText("Looking for your links…")).toBeHidden();
  return region;
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

test.describe("Invite sheet", () => {
  test("Copy on the ready row makes the link and copies it, and Copy on its row copies it again", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      const sheet = await openInvite(page, projectPath);
      await expect(
        sheet.getByRole("heading", { name: "Review links" }),
      ).toBeVisible();
      await expect(
        sheet.getByRole("button", { name: /^Commenter/ }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(await rows(page, projectPath)).toEqual([]);

      await sheet
        .getByRole("button", { name: "Copy new Commenter link" })
        .click();
      await expect(
        sheet.getByRole("button", { name: "Copied Commenter link" }),
      ).toBeVisible();
      const made = (await rows(page, projectPath)).find(
        (r) => r.docs_role === "commenter",
      );
      expect(made?.mcp_url).toBeNull();
      expect(made?.follow_latest).toBe(true);
      expect(await clipboard(page)).toBe(made?.url);

      await page.evaluate(() => navigator.clipboard.writeText("elsewhere"));
      await sheet.getByRole("button", { name: "Copy Commenter link" }).click();
      expect(await clipboard(page)).toBe(made?.url);
      await expectPageAxeClean(page, '[role="dialog"]');
    });
  });

  test("the role, AI assistants and pin choices reach the link", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      const sheet = await openInvite(page, projectPath);
      await sheet.getByRole("button", { name: /^Editor/ }).click();
      await sheet
        .getByRole("button", { name: "More for new Editor link" })
        .click();
      await page
        .getByRole("menuitemradio", { name: "Allow AI assistants" })
        .click();
      await sheet
        .getByRole("button", { name: "Pin to this version" })
        .first()
        .click();
      await sheet.getByRole("button", { name: "Copy new Editor link" }).click();
      await expect(
        sheet
          .getByRole("button", { name: "Copy Editor link" })
          .or(sheet.getByRole("button", { name: "Copied Editor link" })),
      ).toBeVisible();
      const made = (await rows(page, projectPath)).find(
        (r) => r.docs_role === "editor",
      );
      expect(made?.mcp_url).toBeTruthy();
      expect(made?.follow_latest).toBe(false);
      await sheet.getByRole("button", { name: "More for Editor link" }).click();
      await page.getByRole("menuitem", { name: "Copy MCP URL" }).click();
      expect(await clipboard(page)).toBe(made?.mcp_url);
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
      const sheet = await openInvite(page, projectPath);
      await expect(sheet.getByText("Online sharing is off")).toBeVisible();
      const globe = sheet.getByRole("button", { name: "Only on this network" });
      await globe.click();
      await expect(
        sheet.getByText(/Only people on this network can open it/),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sheet).toBeVisible();

      current = tunnel("online");
      await expect(sheet.getByText("Guests can open your links")).toBeVisible();

      current = tunnel("reconnecting", {
        reason_kind: "network",
        retry_at: Date.now() / 1000 + 30,
      });
      await expect(sheet.getByText(/^Reconnecting…/)).toBeVisible();

      current = tunnel("offline", { reason_kind: "auth" });
      await expect(sheet.getByText(/^Not reachable online/)).toBeVisible();
      await sheet.getByText("How to fix").click();
      await expect(
        sheet.getByRole("link", { name: /Online sharing guide/ }),
      ).toBeVisible();
      await expectPageAxeClean(page, '[role="dialog"]');
    });
  });

  test("polls online sharing only while the sheet or Deliver shows", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      let polls = 0;
      await page.route("**/api/tunnel/status", (route) => {
        polls += 1;
        return route.fulfill({ json: tunnel("online") });
      });
      await page.route("**/api/test-barrier", (route) =>
        route.fulfill({ json: {} }),
      );
      const settled = () => page.evaluate(() => fetch("/api/test-barrier"));
      await page.clock.install();
      const sheet = await openInvite(page, projectPath);
      await expect(sheet.getByText("Guests can open your links")).toBeVisible();
      await page.clock.pauseAt(Date.now() + 1_000);
      await settled();
      const shown = polls;
      await page.clock.runFor(TUNNEL_POLL_MS);
      await settled();
      expect(polls).toBe(shown + 1);
      await page.clock.resume();
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      await settled();
      const left = polls;
      await page.clock.runFor(2 * TUNNEL_POLL_MS + 100);
      await settled();
      expect(polls).toBe(left);
    });
  });

  for (const refusal of ["no_mix", "stale_mix"] as const) {
    test(`a ${refusal} refusal offers Refresh mix, then makes the link once`, async ({
      page,
    }) => {
      await withShareableProject(async (projectPath) => {
        const sheet = await openInvite(page, projectPath);
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
        await sheet
          .getByRole("button", { name: "Copy new Commenter link" })
          .click();
        await expect(sheet.getByRole("alert")).toContainText(
          refusal === "no_mix"
            ? "This project has no mix yet. Refresh the mix to create the link."
            : "The mix preview is out of date. Refresh it before creating a review link.",
        );
        await expect(sheet).not.toContainText("premix.wav");
        expect(await rows(page, projectPath)).toEqual([]);

        refuse = false;
        await sheet.getByRole("button", { name: "Refresh mix" }).click();
        await expect(
          sheet
            .getByRole("button", { name: "Copy Commenter link" })
            .or(sheet.getByRole("button", { name: "Copied Commenter link" })),
        ).toBeVisible({ timeout: 60_000 });
        expect(await rows(page, projectPath)).toHaveLength(1);
        await expect(
          sheet.getByRole("button", { name: "Refresh mix" }),
        ).toBeHidden();
      });
    });
  }

  test("a stale_master refusal asks for a new master and offers no Refresh mix", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      const sheet = await openInvite(page, projectPath);
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
      await sheet
        .getByRole("button", { name: "Copy new Commenter link" })
        .click();
      await expect(sheet.getByRole("alert")).toHaveText(
        "The mastered mix is out of date. Export a new master before creating a review link.",
      );
      await expect(
        sheet.getByRole("button", { name: "Refresh mix" }),
      ).toHaveCount(0);
      await expect(sheet).not.toContainText("master_loudness");
    });
  });

  test("record links: create, copy the guest link, and end the room at once", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      const sheet = await openInvite(page, projectPath);
      await sheet.getByRole("button", { name: "Create record links" }).click();
      await expect(
        sheet.getByText("Guest link", { exact: true }),
      ).toBeVisible();
      await expect(
        sheet.getByText("Producer link", { exact: true }),
      ).toBeVisible();
      const room = (await rows(page, projectPath)).find(
        (r) => r.session_id && r.docs_role === null,
      );
      expect(room).toBeTruthy();

      await sheet.getByRole("button", { name: "End room" }).click();
      await expect(sheet.getByText("No record rooms yet.")).toBeVisible();
      expect((await rows(page, projectPath)).filter((r) => r.usable)).toEqual(
        [],
      );
    });
  });

  test("a room made elsewhere is listed under Record links", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      await createRecordRoom(page, projectPath);
      const sheet = await openInvite(page, projectPath);
      await expect(
        sheet.getByRole("heading", { name: "Record links" }),
      ).toBeVisible();
      await expect(
        sheet.getByRole("button", { name: "End room" }),
      ).toBeVisible();
    });
  });

  test("the header Invite opens on every stage, and Escape returns focus to it", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      for (const stage of ["edit", "deliver"] as const) {
        await goToStage(page, stage);
        await openProjectDialog(page, "share");
        const sheet = page.getByRole("dialog", { name: "Invite" });
        await expect(sheet).toBeVisible();
        await expect(
          sheet.getByRole("heading", { name: "Listen link" }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(sheet).toBeHidden();
      }
    });
  });
});

test.describe("Listen link on Deliver", () => {
  test("Copy makes the listen link once, then copies it again", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      const region = await openListen(page, projectPath);
      expect(await rows(page, projectPath)).toEqual([]);
      await region.getByRole("button", { name: /^Copy .*link/ }).click();
      await expect(
        region.getByRole("button", { name: /^Copied .*link/ }),
      ).toBeVisible();
      const [made] = await rows(page, projectPath);
      expect(made.docs_role).toBe("viewer");
      expect(made.mcp_url).toBeNull();
      expect(made.follow_latest).toBe(false);
      expect(await clipboard(page)).toBe(made.url);

      await page.evaluate(() => navigator.clipboard.writeText("elsewhere"));
      await region.getByRole("button", { name: /^Copy .*link/ }).click();
      expect(await clipboard(page)).toBe(made.url);
      expect(await rows(page, projectPath)).toHaveLength(1);
      await expectPageAxeClean(page, ".dv-stage");
    });
  });

  test("Export is the only primary button, and the Listen link sits in the right column", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openListen(page, projectPath);
      await expect(
        deliverPage(page).getByRole("button", { name: "Share a listen link" }),
      ).toHaveCount(0);
      await expect(
        deliverPage(page).getByRole("region", { name: "Share" }),
      ).toHaveCount(0);
      await expect(
        deliverPage(page).locator("button.ui-control.primary"),
      ).toHaveCount(1);
    });
  });
});
