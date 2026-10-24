import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";

let projectPath: string;
let workspaceDir: string;
test.beforeEach(async () => {
  const f = createRelocatedE2eProject("sharecut-e2e-placement-hydrate-");
  projectPath = f.projectPath;
  workspaceDir = f.workspaceDir;
  await switchE2eProject(projectPath);
});
test.afterEach(async ({ page }) => {
  await page.close();
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

test("a late transcript word load keeps an open Move clip form and Apply sends one move", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/document\/state\?.*phase=detail/, async (route) => {
    await gate;
    await route.continue();
  });
  const moves: string[] = [];
  page.on("request", (request) => {
    const body = request.postData() ?? "";
    if (
      request.url().includes("/api/document/command") &&
      /moveClips/i.test(body)
    )
      moves.push(body);
  });

  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  const correct = page.getByRole("button", { name: /correct/i }).first();
  await expect(correct).toBeDisabled();
  await page.locator(".clip-block .clip-hit").first().click();
  const entry = page.getByRole("button", { name: "Move clip", exact: true });
  await expect(entry).toBeEnabled();
  await entry.click();
  const start = page.getByLabel("Timeline start (seconds)");
  await start.fill("7");
  await expect(start).toHaveValue("7");

  release();
  await expect(correct).toBeEnabled();
  await expect(start).toHaveValue("7");
  await page.getByRole("button", { name: "Apply move", exact: true }).click();
  await expect.poll(() => moves.length).toBe(1);
  await expect(start).toHaveCount(0);
  expect(moves).toHaveLength(1);
});
