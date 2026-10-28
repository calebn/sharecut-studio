import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";
import { rememberInspectorDetent } from "../e2e/phoneTimeline";

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
    .getByRole("region", { name: "Range actions" });
  const selectedTrack = barActions.getByRole("checkbox").first();
  await selectedTrack.click();
  await expect(selectedTrack).toBeChecked();

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

  const sheet = page.locator(".bottom-sheet--inspector");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".modifier-badge")).toHaveText("Clip");

  await expect(sheet).toHaveClass(/bottom-sheet--full/);
  await expect(barActions).toHaveCount(0);

  const actions = sheet.getByRole("region", { name: "Range actions" });
  await expect(actions.getByLabel("In")).toBeVisible();
  await expect(actions.getByLabel("Out")).toBeVisible();
  await expect(
    actions.getByRole("button", {
      name: "Use agent range on selected tracks",
    }),
  ).toBeVisible();
  await expect(sheet.locator(".modifier-badge")).toHaveText("Clip");

  const track = actions.getByRole("checkbox").first();
  await expect(track).toBeChecked();
  await actions
    .getByRole("button", { name: "Use agent range on selected tracks" })
    .click();

  const adoptedRange = sheet
    .getByRole("region", { name: "Range actions" })
    .getByText(/4\.00–9\.00 s/);
  await expect(adoptedRange).toHaveText("4.00–9.00 s · reference");
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

  const sheet = page.locator(".bottom-sheet--column");
  await expect(sheet).toBeVisible();
  await expect(page.locator(".bottom-sheet--inspector")).toHaveCount(0);
  const title = await sheet.locator(".bottom-sheet-title").innerText();
  const clientId = fixtureClientId(page, "peek-arrival");
  await clearAgentRange(page, clientId, 1);
  await expect(page.getByRole("region", { name: "Range actions" })).toHaveCount(
    0,
  );
  await publishZeroStartAgentRange(page, clientId, 2);

  const actions = sheet.getByRole("region", { name: "Range actions" });
  await expect(actions).toBeVisible();
  await expect(page.getByRole("region", { name: "Range actions" })).toHaveCount(
    1,
  );
  await expect(sheet.locator(".bottom-sheet-title")).toHaveText(title);
  await expect(actions.getByLabel("In")).toHaveValue("0");
  await expect(actions.getByLabel("Out")).toHaveValue("1");
  const reference = actions.getByRole("checkbox", { name: "reference" });
  const guest = actions.getByRole("checkbox", { name: "guest" });
  await reference.check();
  await expect(reference).toBeChecked();
  await expect(guest).not.toBeChecked();
  await reference.uncheck();
  await guest.check();
  await expect(reference).not.toBeChecked();
  await expect(guest).toBeChecked();

  await actions
    .getByRole("button", { name: "Use agent range on selected tracks" })
    .click();
  await expect(
    sheet
      .getByRole("region", { name: "Range actions" })
      .getByText(/0\.00–2\.00 s/),
  ).toHaveText("0.00–2.00 s · guest");
});

test("a tablet track sheet owns the agent range controls", async ({ page }) => {
  await openHostProject(page);
  const clientId = fixtureClientId(page, "track");
  await clearAgentRange(page, clientId, 1);
  await publishAgentRange(page, clientId, 2);
  const trackName = page.locator(".track-title-text").first();
  const trackNameBox = await trackName.boundingBox();
  if (!trackNameBox) throw new Error("track name has no visible bounds");
  await page.touchscreen.tap(
    trackNameBox.x + trackNameBox.width / 2,
    trackNameBox.y + trackNameBox.height / 2,
  );

  const sheet = page.locator(".bottom-sheet--inspector");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(sheet).toHaveClass(/bottom-sheet--full/);
  const actions = sheet.getByRole("region", { name: "Range actions" });
  await expect(actions.getByLabel("In")).toBeVisible();
  await expect(actions.getByLabel("Out")).toBeVisible();
  await expect(
    actions.getByRole("button", {
      name: "Use agent range on selected tracks",
    }),
  ).toBeVisible();
  await expect(
    page.locator(".edit-timeline-col").getByRole("region", {
      name: "Range actions",
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

  const sheet = page.locator(".bottom-sheet--column");
  await expect(sheet).toBeVisible();
  await expect(page.locator(".bottom-sheet--inspector")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  const title = await sheet.locator(".bottom-sheet-title").innerText();
  const clientId = fixtureClientId(page, "peek-toggle");
  await clearAgentRange(page, clientId, 1);
  await expect(page.getByRole("region", { name: "Range actions" })).toHaveCount(
    0,
  );
  await publishZeroStartAgentRange(page, clientId, 2);

  const actions = sheet.getByRole("region", { name: "Range actions" });
  await expect(
    actions.getByRole("button", {
      name: "Use agent range on selected tracks",
    }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Range actions" })).toHaveCount(
    1,
  );
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(sheet.locator(".bottom-sheet-title")).toHaveText(title);

  const reference = actions.getByRole("checkbox", { name: "reference" });
  const guest = actions.getByRole("checkbox", { name: "guest" });
  await reference.check();
  await expect(reference).toBeChecked();
  await expect(guest).not.toBeChecked();
  await reference.uncheck();
  await guest.check();
  await clearAgentRange(page, clientId, 3);
  await expect(actions).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Range actions" })).toHaveCount(
    0,
  );
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(sheet.locator(".bottom-sheet-title")).toHaveText(title);

  await publishZeroStartAgentRange(page, clientId, 4);
  const restored = sheet.getByRole("region", { name: "Range actions" });
  await expect(restored).toBeVisible();
  await expect(page.getByRole("region", { name: "Range actions" })).toHaveCount(
    1,
  );
  await expect(
    restored.getByRole("checkbox", { name: "reference" }),
  ).not.toBeChecked();
  await expect(restored.getByRole("checkbox", { name: "guest" })).toBeChecked();
});
