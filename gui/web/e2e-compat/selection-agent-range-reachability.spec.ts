import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";
import { rememberInspectorDetent } from "../e2e/phoneTimeline";
import { inspectSelection } from "../e2e/stageNav";

async function sendSessionCommand(
  page: Page,
  clientId: string,
  clientSeq: number,
  type: "SetRegion" | "ClearRegion",
  payload: Record<string, unknown>,
): Promise<void> {
  const projectPath = new URL(page.url()).searchParams.get("project");
  expect(projectPath).not.toBeNull();
  const response = await page.request.post(
    `${new URL("/api/session/command", page.url())}?path=${encodeURIComponent(projectPath!)}`,
    {
      data: {
        client_id: clientId,
        client_seq: clientSeq,
        role: "agent",
        type,
        payload,
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

async function clearAgentRange(
  page: Page,
  clientId: string,
  clientSeq: number,
): Promise<void> {
  await sendSessionCommand(page, clientId, clientSeq, "ClearRegion", {
    stop: false,
  });
}

function fixtureClientId(page: Page, purpose: string): string {
  return `public-fixture-agent-${purpose}-${page.context().browser()?.browserType().name()}-${randomUUID()}`;
}

async function publishAgentRange(
  page: Page,
  clientId: string,
  clientSeq: number,
): Promise<void> {
  await sendSessionCommand(page, clientId, clientSeq, "SetRegion", {
    start_sec: 4,
    end_sec: 9,
    playhead_sec: 4,
    is_playing: false,
    query: null,
  });
}

async function publishZeroStartAgentRange(
  page: Page,
  clientId: string,
  clientSeq: number,
): Promise<void> {
  await sendSessionCommand(page, clientId, clientSeq, "SetRegion", {
    start_sec: 0,
    end_sec: 2,
    playhead_sec: 0,
    is_playing: false,
    query: null,
  });
}

test.use({
  actionTimeout: 15_000,
  hasTouch: true,
  viewport: { width: 820, height: 1180 },
});

/** Set a Scope toggle on or off; the last one on refuses to switch off. */
async function setScope(toggle: Locator, on: boolean): Promise<void> {
  const pressed = (await toggle.getAttribute("aria-pressed")) === "true";
  if (pressed !== on) await toggle.click();
}

test("agent range controls stay reachable from a tablet clip sheet", async ({
  page,
}) => {
  await rememberInspectorDetent(page, "full");
  await openHostProject(page);
  const clientId = fixtureClientId(page, "clip");
  await clearAgentRange(page, clientId, 1);
  await publishAgentRange(page, clientId, 2);

  const barActions = page
    .locator(".edit-timeline-col")
    .getByRole("region", { name: "Range fields" });
  const selectedTrack = barActions
    .getByRole("group", { name: "Scope" })
    .getByRole("button")
    .first();
  await selectedTrack.click();
  await expect(selectedTrack).toHaveAttribute("aria-pressed", "true");

  const clip = page.locator(".lane-row .clip-hit").first();
  await clip.scrollIntoViewIfNeeded();
  const point = await clip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      x: bounds.left + Math.min(40, bounds.width / 2),
      y: bounds.top + bounds.height / 2,
    };
  });
  await page.touchscreen.tap(point.x, point.y);
  await inspectSelection(page);

  const sheet = page.locator(".sys-inspector");
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByRole("spinbutton", { name: "Source start", exact: true }),
  ).toBeVisible();

  await expect(barActions).toHaveCount(0);

  const actions = sheet.getByRole("region", { name: "Range fields" });
  await expect(
    actions.getByRole("button", {
      name: "Use agent range on selected tracks",
    }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("spinbutton", { name: "Source start", exact: true }),
  ).toBeVisible();

  const track = actions
    .getByRole("group", { name: "Scope" })
    .getByRole("button")
    .first();
  await expect(track).toHaveAttribute("aria-pressed", "true");
  await actions
    .getByRole("button", { name: "Use agent range on selected tracks" })
    .click();

  const adopted = sheet.getByRole("region", { name: "Range fields" });
  await expect(
    adopted.getByRole("spinbutton", { name: "In", exact: true }),
  ).toHaveAttribute("aria-valuenow", "4");
  await expect(
    adopted.getByRole("spinbutton", { name: "Out", exact: true }),
  ).toHaveAttribute("aria-valuenow", "9");
});

test("a zero-start agent range arriving at the short-tablet column stays reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 620 });
  await openHostProject(page);

  const clip = page.locator(".lane-row .clip-hit").first();
  await clip.scrollIntoViewIfNeeded();
  const point = await clip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      x: bounds.left + Math.min(40, bounds.width / 2),
      y: bounds.top + bounds.height / 2,
    };
  });
  await page.touchscreen.tap(point.x, point.y);
  await inspectSelection(page);

  const sheet = page.locator(".sys-inspector");
  await expect(sheet).toBeVisible();
  const title = await sheet.locator(".sys-sheet-title").innerText();
  const clientId = fixtureClientId(page, "peek-arrival");
  await clearAgentRange(page, clientId, 1);
  await expect(page.getByRole("region", { name: "Range fields" })).toHaveCount(
    0,
  );
  await publishZeroStartAgentRange(page, clientId, 2);

  const actions = sheet.getByRole("region", { name: "Range fields" });
  await expect(actions).toBeVisible();
  await expect(page.getByRole("region", { name: "Range fields" })).toHaveCount(
    1,
  );
  await expect(sheet.locator(".sys-sheet-title")).toHaveText(title);
  const reference = actions.getByRole("button", {
    name: "reference",
    exact: true,
  });
  const guest = actions.getByRole("button", { name: "guest", exact: true });
  await setScope(reference, true);
  await setScope(guest, false);
  await expect(reference).toHaveAttribute("aria-pressed", "true");
  await expect(guest).toHaveAttribute("aria-pressed", "false");
  await setScope(guest, true);
  await setScope(reference, false);
  await expect(reference).toHaveAttribute("aria-pressed", "false");
  await expect(guest).toHaveAttribute("aria-pressed", "true");

  await actions
    .getByRole("button", { name: "Use agent range on selected tracks" })
    .click();
  const adopted = sheet.getByRole("region", { name: "Range fields" });
  await expect(
    adopted.getByRole("spinbutton", { name: "In", exact: true }),
  ).toHaveAttribute("aria-valuenow", "0");
  await expect(
    adopted.getByRole("spinbutton", { name: "Out", exact: true }),
  ).toHaveAttribute("aria-valuenow", "2");
});

test("a tablet track sheet owns the agent range controls", async ({ page }) => {
  await openHostProject(page);
  const clientId = fixtureClientId(page, "track");
  await clearAgentRange(page, clientId, 1);
  await publishAgentRange(page, clientId, 2);
  const trackName = page.locator(".sys-track-name").first();
  const trackNameBox = await trackName.boundingBox();
  if (!trackNameBox) throw new Error("track name has no visible bounds");
  await page.touchscreen.tap(
    trackNameBox.x + trackNameBox.width / 2,
    trackNameBox.y + trackNameBox.height / 2,
  );

  const sheet = page.locator(".sys-inspector");
  await expect(sheet).toBeVisible();
  const actions = sheet.getByRole("region", { name: "Range fields" });
  await expect(
    actions.getByRole("button", {
      name: "Use agent range on selected tracks",
    }),
  ).toBeVisible();
  await expect(
    page.locator(".edit-timeline-col").getByRole("region", {
      name: "Range fields",
    }),
  ).toHaveCount(0);
});

test("agent range arrival and removal keep the short-tablet column reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 620 });
  await openHostProject(page);

  const clip = page.locator(".lane-row .clip-hit").first();
  await clip.scrollIntoViewIfNeeded();
  const point = await clip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      x: bounds.left + Math.min(40, bounds.width / 2),
      y: bounds.top + bounds.height / 2,
    };
  });
  await page.touchscreen.tap(point.x, point.y);
  await inspectSelection(page);

  const sheet = page.locator(".sys-inspector");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  const title = await sheet.locator(".sys-sheet-title").innerText();
  const clientId = fixtureClientId(page, "peek-toggle");
  await clearAgentRange(page, clientId, 1);
  await expect(page.getByRole("region", { name: "Range fields" })).toHaveCount(
    0,
  );
  await publishZeroStartAgentRange(page, clientId, 2);

  const actions = sheet.getByRole("region", { name: "Range fields" });
  await expect(
    actions.getByRole("button", {
      name: "Use agent range on selected tracks",
    }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Range fields" })).toHaveCount(
    1,
  );
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(sheet.locator(".sys-sheet-title")).toHaveText(title);

  const reference = actions.getByRole("button", {
    name: "reference",
    exact: true,
  });
  const guest = actions.getByRole("button", { name: "guest", exact: true });
  await setScope(reference, true);
  await setScope(guest, false);
  await expect(reference).toHaveAttribute("aria-pressed", "true");
  await expect(guest).toHaveAttribute("aria-pressed", "false");
  await setScope(guest, true);
  await setScope(reference, false);
  await clearAgentRange(page, clientId, 3);
  await expect(actions).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Range fields" })).toHaveCount(
    0,
  );
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(sheet.locator(".sys-sheet-title")).toHaveText(title);

  await publishZeroStartAgentRange(page, clientId, 4);
  const restored = sheet.getByRole("region", { name: "Range fields" });
  await expect(restored).toBeVisible();
  await expect(page.getByRole("region", { name: "Range fields" })).toHaveCount(
    1,
  );
  await expect(
    restored.getByRole("button", { name: "reference", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    restored.getByRole("button", { name: "guest", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
