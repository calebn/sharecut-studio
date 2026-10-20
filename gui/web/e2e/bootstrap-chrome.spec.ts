import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
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

    await page.routeWebSocket(/\/api\/host\/ws/, () => undefined);

    await page.route(
      (url) => new URL(url).pathname === "/api/document/state",
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
    const play = page.getByRole("button", { name: "Play", exact: true });
    const stop = page.getByRole("button", { name: "Stop playback" });
    await expect(
      page.getByText("Loading project…", { exact: true }),
    ).toBeVisible();
    for (const button of [play, stop]) {
      await expect(button).toHaveAttribute("aria-disabled", "true");
      await expect(button).toHaveAccessibleDescription("Loading project…");
      await button.click({ force: true });
      await button.press("Enter");
      await button.press("Space");
    }
    await expect(play).toHaveAccessibleName("Play");
    await expect(page.getByLabel("Loading timeline")).toBeVisible();
    await expect(page.getByText(/Drop audio files/)).toHaveCount(0);
    await expect(page.locator("main.daw-main")).not.toHaveClass(
      /daw-main--arrange/,
    );
    await expectPageAxeClean(page);

    releaseShell();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await expect(play).not.toHaveAttribute("aria-disabled");
    await expect(stop).not.toHaveAttribute("aria-disabled");
    await expect(
      page.getByText("Loading project…", { exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => phases.includes("detail")).toBe(true);
    await expectPageAxeClean(page);

    const shellIdx = phases.indexOf("shell");
    const detailIdx = phases.indexOf("detail");
    expect(shellIdx).toBeGreaterThanOrEqual(0);
    expect(detailIdx).toBeGreaterThan(shellIdx);
  });

  test("draws the loading skeleton from the headers' edge and sweeps it on the compositor", async ({
    page,
  }) => {
    await page.routeWebSocket(/\/api\/host\/ws/, () => undefined);
    await page.route(
      (url) => new URL(url).pathname === "/api/document/state",
      () => new Promise<void>(() => undefined),
    );
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`, {
      waitUntil: "commit",
    });
    await expect(page.getByLabel("Loading timeline")).toBeVisible();

    const painted = await page.evaluate(() => {
      const scroll = document.querySelector(
        ".timeline-area[aria-busy='true'] .timeline-scroll",
      ) as HTMLElement;
      const headers = document
        .querySelector(".track-headers")!
        .getBoundingClientRect();
      const area = scroll.getBoundingClientRect();
      const shimmers = document
        .getAnimations()
        .filter(
          (a) =>
            a instanceof CSSAnimation && a.animationName === "timeline-shimmer",
        )
        .map((a) => {
          const effect = a.effect as KeyframeEffect;
          return {
            pseudo: effect.pseudoElement,
            properties: effect
              .getKeyframes()
              .flatMap((k) => Object.keys(k))
              .filter(
                (name) =>
                  !["offset", "computedOffset", "easing", "composite"].includes(
                    name,
                  ),
              ),
          };
        });
      return {
        gap: area.left - headers.right,
        scrollImage: getComputedStyle(scroll).backgroundImage,
        shimmers,
      };
    });

    // The scroller paints no header plane of its own: the headers are drawn
    // beside it, so a plane here would be a pale block next to them (#1750).
    expect(Math.abs(painted.gap)).toBeLessThanOrEqual(1);
    expect(painted.scrollImage).toBe("none");
    // Six lanes (three headers, three lanes) sweep with transform alone, which
    // the compositor keeps moving while the main thread parses the project.
    expect(painted.shimmers).toHaveLength(6);
    for (const shimmer of painted.shimmers) {
      expect(shimmer.pseudo).toBe("::after");
      expect(new Set(shimmer.properties)).toEqual(new Set(["transform"]));
    }
  });
});
