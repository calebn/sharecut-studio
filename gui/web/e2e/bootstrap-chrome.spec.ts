import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

test.describe("Chrome-first bootstrap", () => {
  test("shows loading chrome then hydrates shell before detail", async ({
    page,
  }) => {
    let releaseShell: () => void = () => undefined;
    const holdShell = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });
    const phases: string[] = [];

    // Hello Snapshot on /api/document/ws is a shell ProjectView and hydrates
    // independently of GET /api/project. Mock the socket so chrome-null stays
    // on screen while HTTP shell is held.
    await page.routeWebSocket(/\/api\/document\/ws/, () => undefined);

    await page.route(
      (url) => new URL(url).pathname === "/api/project",
      async (route) => {
        const phase =
          new URL(route.request().url()).searchParams.get("phase") ?? "shell";
        phases.push(phase);
        if (phase === "shell") {
          await holdShell;
        }
        await route.continue();
      },
    );

    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`, {
      waitUntil: "commit",
    });

    await expect(page.getByText("Loading episode…").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Play" })).toBeDisabled();
    await expect(page.getByLabel("Loading timeline")).toBeVisible();
    await expect(page.getByText(/Drop audio files/)).toHaveCount(0);
    await expect(page.locator("main.daw-main")).not.toHaveClass(
      /daw-main--arrange/,
    );

    releaseShell();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();
    await expect.poll(() => phases.includes("detail")).toBe(true);

    const shellIdx = phases.indexOf("shell");
    const detailIdx = phases.indexOf("detail");
    expect(shellIdx).toBeGreaterThanOrEqual(0);
    expect(detailIdx).toBeGreaterThan(shellIdx);
  });
});
