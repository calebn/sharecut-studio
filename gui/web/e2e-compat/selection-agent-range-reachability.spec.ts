import { expect, type Page, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";

async function publishAgentRange(page: Page): Promise<void> {
  const projectPath = new URL(page.url()).searchParams.get("project");
  expect(projectPath).not.toBeNull();
  const response = await page.request.post(
    `${new URL("/api/session/command", page.url())}?path=${encodeURIComponent(projectPath!)}`,
    {
      data: {
        client_id: "public-fixture-agent",
        client_seq: 1,
        role: "agent",
        type: "SetRegion",
        payload: {
          start_sec: 4,
          end_sec: 9,
          playhead_sec: 4,
          is_playing: false,
          query: null,
        },
      },
    },
  );
  expect(response.ok()).toBe(true);
}

test.use({
  actionTimeout: 15_000,
  hasTouch: true,
  viewport: { width: 820, height: 1180 },
});

test("agent range controls stay reachable from a tablet clip sheet", async ({
  page,
}) => {
  await openHostProject(page);
  await publishAgentRange(page);

  const barActions = page
    .locator(".daw-shell-transport")
    .getByRole("region", { name: "Range actions" });
  const selectedTrack = barActions.getByRole("checkbox").first();
  await selectedTrack.click();
  await expect(selectedTrack).toBeChecked();

  const clip = page.locator(".lane-row .clip-hit").first();
  await clip.scrollIntoViewIfNeeded();
  const point = await clip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    };
  });
  await page.touchscreen.tap(point.x, point.y);

  const sheet = page.getByRole("dialog", { name: "Inspector" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".modifier-badge")).toHaveText("Clip");

  await sheet.getByRole("button", { name: "Expand", exact: true }).click();
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
