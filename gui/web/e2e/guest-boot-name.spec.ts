import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
import { fontsReady } from "./fontsReady";
import {
  firstPaintAfterHtml,
  holdScripts,
  installBootProbes,
  reactDrewLoadingHeader,
  readBootProbes,
  securityViolations,
  sinceHtml,
  waitSinceHtml,
} from "./guestBootProbes";
import {
  episodeName,
  holdFirstProject,
  SIZES,
  type Size,
  withGuestLink,
} from "./guestLink";
import {
  headerBoxes,
  installProbes,
  lateArrivals,
  type Rect,
  readProbes,
  shiftSum,
} from "./guestLoadingProbes";

const SCRIPT_HOLD_MS = 3000;
const PROJECT_HOLD_MS = 2000;
const SHIFT_BUDGET = 0.002;
const HEADER_HEIGHT = { phone: 45, desktop: 49 } as const;
const SHOTS = process.env.GUEST_LOADING_SHOTS;

const ALL = ["x", "y", "w", "h"] as const;
const NOT_WIDTH = ["x", "y", "h"] as const;

const near = (
  got: Rect | null,
  want: Rect | null,
  state: string,
  keys: readonly (keyof Rect)[] = ALL,
) => {
  expect.soft(got, `${state}: a box`).not.toBeNull();
  expect.soft(want, `${state}: a box to compare with`).not.toBeNull();
  if (!got || !want) return;
  for (const key of keys)
    expect
      .soft(
        Math.abs(got[key] - want[key]),
        `${state} ${key}: ${JSON.stringify(got)} against ${JSON.stringify(want)}`,
      )
      .toBeLessThanOrEqual(1);
};

const status = (page: Page) =>
  page.locator("main.guest-loading > [role=status]");

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Console errors and page errors, with the link's token taken out of what is kept. */
function watchErrors(page: Page, token: string) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push(message.text().split(token).join("<TOKEN>"));
  });
  page.on("pageerror", (error) =>
    errors.push(error.message.split(token).join("<TOKEN>")),
  );
  return errors;
}

/**
 * Opens the link with every script held, reads the page the server wrote, lets
 * the script take over, and reads React's loading header and the landed one.
 */
async function openHeld(
  guest: Page,
  token: string,
  name: string,
  size: Size,
  tag: string,
) {
  const errors = watchErrors(guest, token);
  await installProbes(guest);
  await installBootProbes(guest, name);
  const scripts = await holdScripts(guest, SCRIPT_HOLD_MS);
  await holdFirstProject(guest, token, PROJECT_HOLD_MS);
  await guest.goto(`/r/${token}`, { waitUntil: "commit" });

  // The first paint is the page the server wrote: nothing has run yet.
  const paintedAfterHtml = await firstPaintAfterHtml(guest);
  const stillAway = !scripts.released();
  const titles = await guest.locator(".sys-header-title").count();
  const root = await guest.locator("#root > *").count();
  const writtenAt = await sinceHtml(guest);
  expect(stillAway, "the first paint came before the script").toBe(true);
  expect(titles, "titles on the first paint").toBe(1);
  expect(root, "children of the root on the first paint").toBe(1);
  await shot(guest, `${tag}-first-paint`);
  await expect(guest.locator(".sys-header-title")).toHaveText(name);
  await expect(status(guest)).toHaveText(`Loading ${name}…`);
  await expect(guest.locator(".sys-header-sub")).toHaveText("Loading…");
  await expect(guest.locator("#root h1")).toHaveText(name);
  await fontsReady(guest);
  const written = await headerBoxes(guest);

  await waitSinceHtml(guest, 1000);
  await shot(guest, `${tag}-1s`);
  await waitSinceHtml(guest, SCRIPT_HOLD_MS - 400);
  const stillAwayLate = !scripts.released();
  await shot(guest, `${tag}-2.6s`);
  expect(stillAwayLate, "the script is away at 2.6 s").toBe(true);

  await expect.poll(() => reactDrewLoadingHeader(guest)).toBe(true);
  await expect(status(guest)).toHaveText(`Loading ${name}…`);
  await fontsReady(guest);
  const drawn = await headerBoxes(guest);
  await shot(guest, `${tag}-after-takeover`);

  await expect(guest.locator(".stage-frame--guest")).toBeVisible();
  await expect(guest.locator(".sys-app-header-host")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(guest.locator(".sys-header-title")).toHaveText(name);
  await fontsReady(guest);
  await lateArrivals(guest, size.touch);
  const landed = await headerBoxes(guest);
  await shot(guest, `${tag}-landed`);

  const boot = await readBootProbes(guest);
  const shifts = await readProbes(guest);
  const measured = {
    paintedAfterHtml,
    writtenAt,
    frames: boot.frames,
    callbacks: boot.callbacks,
    shift: shiftSum(shifts),
    written,
    drawn,
    landed,
  };
  test.info().annotations.push({
    type: `measured ${tag}`,
    description: JSON.stringify(measured),
  });
  return {
    ...measured,
    boot,
    shifts,
    errors,
    violations: await securityViolations(guest),
  };
}

for (const size of SIZES) {
  const height = HEADER_HEIGHT[size.name];
  test.describe(`a review link opening at ${size.width}x${size.height}`, () => {
    for (const theme of ["light", "dark"] as const) {
      test(`the page names the episode before the script, and nothing moves when the script takes over (${theme})`, async ({
        browser,
      }) => {
        test.setTimeout(90_000);
        await withGuestLink(browser, size, async (guest, token) => {
          const name = await episodeName(guest, token);
          await guest.emulateMedia({ colorScheme: theme });
          const run = await openHeld(
            guest,
            token,
            name,
            size,
            `${size.name}-${theme}`,
          );

          await test.step("the name and Loading… are on the first paint, before the script", () => {
            expect(run.paintedAfterHtml).toBeLessThan(1000);
            expect(run.written.host).toEqual({
              x: 0,
              y: 0,
              w: size.width,
              h: height,
            });
          });
          await test.step("the same box in the written page, the loading header and the studio", () => {
            near(run.drawn.title, run.written.title, "loading", ALL);
            near(run.landed.title, run.written.title, "landed", ALL);
            expect(run.drawn.host).toEqual(run.written.host);
            expect(run.landed.host).toEqual(run.written.host);
          });
          await test.step("no frame and no change of the page without the name or without a root child", () => {
            expect(run.boot.frames).toBeGreaterThan(20);
            expect(run.boot.callbacks).toBeGreaterThan(0);
            expect(run.boot.gaps).toEqual([]);
          });
          await test.step("layout shift across the landing", () => {
            expect(run.shift, JSON.stringify(run.shifts.shifts)).toBeLessThan(
              SHIFT_BUDGET,
            );
          });
          await test.step("no console error and no security policy violation", () => {
            expect(run.errors).toEqual([]);
            expect(run.violations).toEqual([]);
          });
        });
      });

      test(`axe finds nothing on the page the server wrote, with the script away (${theme})`, async ({
        browser,
      }) => {
        await withGuestLink(browser, size, async (guest, token) => {
          const name = await episodeName(guest, token);
          await guest.emulateMedia({ colorScheme: theme });
          await guest.route("**/assets/*.js", (route) => route.abort());
          await guest.goto(`/r/${token}`, { waitUntil: "commit" });
          await expect(guest.locator(".sys-header-title")).toHaveText(name);
          await fontsReady(guest);
          await expectReadingSurfaceAxeClean(guest);
        });
      });
    }

    const NAMES = {
      "markup characters": `A <B> & "C" 'D'`,
      "120 unbroken characters": "x".repeat(120),
      Arabic: "الحلقة الأولى من البودكاست",
      Hebrew: "הפרק הראשון של ההסכת",
    };
    for (const [kind, name] of Object.entries(NAMES)) {
      test(`a name of ${kind} shows as text and keeps its box when the script takes over`, async ({
        browser,
      }) => {
        test.setTimeout(90_000);
        await withGuestLink(
          browser,
          size,
          async (guest, token, host, projectPath) => {
            await postDocumentCommand(
              host,
              "name-writer",
              "RenameProject",
              { name },
              projectPath,
            );
            const run = await openHeld(
              guest,
              token,
              name,
              size,
              `${size.name}-${kind.replaceAll(" ", "-")}`,
            );
            expect(await guest.locator("#root b").count()).toBe(0);
            near(run.drawn.title, run.written.title, "loading", ALL);
            // A long name ends in an ellipsis at the room the right-hand
            // controls leave, which the written page does not have yet.
            near(
              run.landed.title,
              run.written.title,
              "landed",
              kind === "120 unbroken characters" ? NOT_WIDTH : ALL,
            );
            expect(run.boot.gaps).toEqual([]);
            expect(run.errors).toEqual([]);
            expect(run.violations).toEqual([]);
            expect(run.shift).toBeLessThan(SHIFT_BUDGET);
          },
        );
      });
    }

    test("a long name ends in an ellipsis inside the bar, in the page the server wrote", async ({
      browser,
    }) => {
      await withGuestLink(
        browser,
        size,
        async (guest, token, host, projectPath) => {
          const name = "x".repeat(120);
          await postDocumentCommand(
            host,
            "name-writer",
            "RenameProject",
            { name },
            projectPath,
          );
          await guest.route("**/assets/*.js", (route) => route.abort());
          await guest.goto(`/r/${token}`, { waitUntil: "commit" });
          const title = guest.locator(".sys-header-title");
          await expect(title).toHaveText(name);
          await fontsReady(guest);
          const fit = await title.evaluate((el) => {
            const bar = el
              .closest(".sys-app-header-host")!
              .getBoundingClientRect();
            const box = el.getBoundingClientRect();
            return {
              ellipsis: getComputedStyle(el).textOverflow === "ellipsis",
              clipped: el.scrollWidth > el.clientWidth,
              inside: box.left >= bar.left && box.right <= bar.right,
            };
          });
          expect(fit).toEqual({ ellipsis: true, clipped: true, inside: true });
        },
      );
    });

    for (const kind of ["unknown", "turned-off"] as const) {
      test(`a ${kind} link has an empty root and no name while the script is away`, async ({
        browser,
      }) => {
        test.setTimeout(60_000);
        await withGuestLink(browser, size, async (guest, token, host, path) => {
          const name = await episodeName(guest, token);
          let target = token;
          if (kind === "unknown") {
            target = `${token.slice(0, -4)}${token.endsWith("zzzz") ? "yyyy" : "zzzz"}`;
          } else {
            const ended = await host.request.post(
              `/api/shares/${token}/revoke`,
              { data: { path } },
            );
            expect(ended.ok()).toBeTruthy();
          }
          const scripts = await holdScripts(guest, SCRIPT_HOLD_MS);
          await guest.goto(`/r/${target}`, { waitUntil: "commit" });
          for (const at of [100, SCRIPT_HOLD_MS - 400]) {
            await waitSinceHtml(guest, at);
            expect(scripts.released(), `read at ${at} ms`).toBe(false);
            await expect(guest.locator("#root")).toBeEmpty();
            await expect(guest.locator(".sys-header-title")).toHaveCount(0);
            expect(await guest.content()).not.toContain(name);
            expect(await guest.title()).toBe("ShareCut Studio");
          }
        });
      });
    }
  });
}
