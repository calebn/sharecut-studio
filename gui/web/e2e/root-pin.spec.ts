import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { switchE2eProject } from "./shareableProject";

test("loading / with a pinned project opens it and never unpins it (#533)", async ({
  page,
}) => {
  await switchE2eProject(e2eProjectPath);
  const served = fs.realpathSync(e2eProjectPath);
  const closes: string[] = [];
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      new URL(r.url()).pathname === "/api/project/close"
    ) {
      closes.push(r.url());
    }
  });
  await page.addInitScript(() => {
    window.localStorage.setItem("sharecut.bootstrap.skip", "1");
  });
  await page.goto("/");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("project"))
    .toBe(served);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto("/?home=1");
  await expect(
    page.getByRole("button", { name: "New project…" }),
  ).toBeVisible();
  await page.goto("/");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("project"))
    .toBe(served);
  expect(closes).toEqual([]);
});
