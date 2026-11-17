import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
import { fontsReady } from "./fontsReady";
import {
  episodeName,
  holdChunk,
  holdFirstProject,
  SIZES,
  withGuestLink,
} from "./guestLink";
import {
  headerBoxes,
  installProbes,
  type Rect,
  readProbes,
  shiftSum,
} from "./guestLoadingProbes";
import { createRecordRoom } from "./recordRoom";

const HEADER_HEIGHT = { phone: 45, desktop: 49 } as const;
/** The entries that are not the header's (right-hand controls, Listen strip) can merge into one frame and count about 0.0035. */
const SHIFT_BUDGET_RACE = 0.005;
const SHOTS = process.env.GUEST_LOADING_SHOTS;

const ALL = ["x", "y", "w", "h"] as const;
const NOT_WIDTH = ["x", "y", "h"] as const;

const near = (
  got: Rect | null,
  want: Rect | null,
  tolerance = 1,
  keys: readonly (keyof Rect)[] = ALL,
) => {
  expect.soft(got, "the title has a box").not.toBeNull();
  expect.soft(want, "the title has a box to compare with").not.toBeNull();
  if (!got || !want) return;
  for (const key of keys)
    expect
      .soft(
        Math.abs(got[key] - want[key]),
        `${key}: ${JSON.stringify(got)} against ${JSON.stringify(want)}`,
      )
      .toBeLessThanOrEqual(tolerance);
};

/** The screen reader's line, not the "Still loading…" row that has a status role too. */
const status = (page: Page) =>
  page.locator("main.guest-loading > [role=status]");

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function landed(page: Page, name: string) {
  await expect(page.locator(".stage-frame--guest")).toBeVisible();
  await expect(page.locator(".sys-app-header-host")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(page.locator(".sys-header-title")).toHaveText(name);
  await expect(page.locator(".sys-header-sub")).not.toContainText(
    "Shared link",
  );
  await fontsReady(page);
}

for (const size of SIZES) {
  const height = HEADER_HEIGHT[size.name];
  test.describe(`a review link opening at ${size.width}x${size.height}`, () => {
    for (const theme of ["light", "dark"] as const) {
      test(`the header and the name hold still from the loading screen to the studio (${theme})`, async ({
        browser,
      }) => {
        await withGuestLink(browser, size, async (guest, token) => {
          const name = await episodeName(guest, token);
          await guest.emulateMedia({ colorScheme: theme });
          await installProbes(guest);
          await holdFirstProject(guest, token, 2500);
          const studio = await holdChunk(guest, "dawApp");
          await guest.goto(`/r/${token}`, { waitUntil: "commit" });

          let unnamed: Awaited<ReturnType<typeof headerBoxes>>;
          await test.step("while /project is held: the unnamed loading frame", async () => {
            await expect(
              guest.locator(".sys-skeleton-block--player"),
            ).toBeVisible();
            await shot(guest, `${size.name}-${theme}-1s`);
            await expect
              .soft(status(guest))
              .toHaveText("Loading the episode…", { timeout: 3000 });
            unnamed = await headerBoxes(guest);
            expect.soft(unnamed.host).toEqual({
              x: 0,
              y: 0,
              w: size.width,
              h: height,
            });
            expect.soft(unnamed.block).not.toBeNull();
            expect.soft(unnamed.title).toBeNull();
          });

          let named: Awaited<ReturnType<typeof headerBoxes>>;
          await test.step("after /project answers, before the studio: the name in the title's place", async () => {
            await expect
              .soft(status(guest))
              .toHaveText(`Loading ${name}…`, { timeout: 6000 });
            await shot(guest, `${size.name}-${theme}-2.5s`);
            await fontsReady(guest);
            named = await headerBoxes(guest);
            expect.soft(named.host).toEqual({
              x: 0,
              y: 0,
              w: size.width,
              h: height,
            });
            await expect
              .soft(guest.locator(".sys-header-sub"))
              .toContainText("Loading…", { timeout: 3000 });
          });

          await test.step("studio mounted: same bar, same title box, before and after the version label", async () => {
            studio.release();
            await expect(guest.locator(".stage-frame--guest")).toBeVisible();
            await expect(guest.locator(".sys-header-title")).toHaveText(name);
            await fontsReady(guest);
            const first = await headerBoxes(guest);
            expect.soft(first.host).toEqual(named.host);
            near(first.title, named.title);
            await landed(guest, name);
            await shot(guest, `${size.name}-${theme}-landed`);
            const last = await headerBoxes(guest);
            expect.soft(last.host).toEqual({
              x: 0,
              y: 0,
              w: size.width,
              h: height,
            });
            near(last.title, named.title);
            const boxes = JSON.stringify({ unnamed, named, first, last });
            test.info().annotations.push({ type: "boxes", description: boxes });
          });

          const probes = await readProbes(guest);
          await test.step("html[data-shell] is set when the studio frame is first added", () => {
            expect
              .soft(probes.shellAtFrame)
              .toBe(size.touch ? "phone" : "desktop");
          });
          await test.step("the header never says Project to a guest", () => {
            expect
              .soft(probes.titles.map((t) => t.text))
              .not.toContain("Project");
            expect(probes.titles.at(-1)?.text).toBe(name);
          });
          await test.step("once the grey blocks are up they never go until the studio mounts", () => {
            const first = probes.blocks.findIndex((b) => b.count > 0);
            expect(first).toBeGreaterThanOrEqual(0);
            expect
              .soft(probes.blocks.slice(first).map((b) => b.count))
              .not.toContain(0);
          });
        });
      });

      test(`the landing moves nothing (${theme}): no layout shift from the header, total under ${SHIFT_BUDGET_RACE}`, async ({
        browser,
      }) => {
        await withGuestLink(browser, size, async (guest, token) => {
          const name = await episodeName(guest, token);
          await guest.emulateMedia({ colorScheme: theme });
          await installProbes(guest);
          await holdFirstProject(guest, token, 3000);
          await guest.goto(`/r/${token}`, { waitUntil: "commit" });
          await landed(guest, name);
          await guest.waitForTimeout(1500);
          const probes = await readProbes(guest);
          test.info().annotations.push({
            type: "layout-shift",
            description: JSON.stringify({
              sum: shiftSum(probes),
              entries: probes.shifts,
            }),
          });
          // What the header's own height moved: the body under it, the
          // first-visit hint and the title. The sum is a race with the first
          // paint, and the controls that arrive on the right of the header and
          // the Listen strip are not the header's height.
          const moved = probes.shifts.flatMap((entry) =>
            entry.sources.map((source) => source.node),
          );
          for (const node of [
            "main.stage-frame-body",
            "span.sys-coach-tip",
            "span.sys-header-title",
            "div.sys-header-guest",
            "div.sys-header-left",
          ])
            expect(moved, JSON.stringify(probes.shifts)).not.toContain(node);
          expect(shiftSum(probes), JSON.stringify(probes.shifts)).toBeLessThan(
            SHIFT_BUDGET_RACE,
          );
        });
      });
    }

    test("Still loading… comes 4 s after the first screen mounted, not after the second", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await installProbes(guest);
        await holdFirstProject(guest, token, 1000);
        await holdChunk(guest, "dawApp");
        await guest.goto(`/r/${token}`, { waitUntil: "commit" });
        await expect(guest.getByText("Still loading…")).toBeVisible({
          timeout: 8000,
        });
        const probes = await readProbes(guest);
        const wait = probes.stillLoadingAt! - probes.firstLoadingAt!;
        expect(wait).toBeGreaterThan(3900);
        expect(wait).toBeLessThan(4600);
      });
    });

    test("the loading screen says what it is in the guest's words, and never project", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        const name = await episodeName(guest, token);
        await holdFirstProject(guest, token, 2000);
        const studio = await holdChunk(guest, "dawApp");
        await guest.goto(`/r/${token}`, { waitUntil: "commit" });
        await expect(status(guest)).toHaveText("Loading the episode…");
        const unnamedText = await guest
          .locator("main.guest-loading")
          .innerText();
        expect(unnamedText.toLowerCase()).not.toContain("project");
        await expect(status(guest)).toHaveText(`Loading ${name}…`, {
          timeout: 8000,
        });
        const namedText = await guest.locator("main.guest-loading").innerText();
        expect(namedText.toLowerCase()).not.toContain("project");
        expect(namedText).toContain(name);
        studio.release();
      });
    });

    test("axe finds nothing on the unnamed and the named loading screen", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        const name = await episodeName(guest, token);
        await holdFirstProject(guest, token, 1500);
        const studio = await holdChunk(guest, "dawApp");
        await guest.goto(`/r/${token}`, { waitUntil: "commit" });
        await expect(
          guest.locator(".sys-skeleton-block--player"),
        ).toBeVisible();
        await expectReadingSurfaceAxeClean(guest);
        await expect(status(guest)).toHaveText(`Loading ${name}…`, {
          timeout: 8000,
        });
        await expectReadingSurfaceAxeClean(guest);
        studio.release();
      });
    });

    const NAMES = {
      "120 unbroken characters": "x".repeat(120),
      Arabic: "الحلقة الأولى من البودكاست",
      Hebrew: "הפרק הראשון של ההסכת",
      "markup characters": `A <B> & "C" '`,
    };
    for (const [kind, odd] of Object.entries(NAMES)) {
      test(`a name of ${kind} keeps its box from the loading screen to the studio`, async ({
        browser,
      }) => {
        await withGuestLink(
          browser,
          size,
          async (guest, token, host, projectPath) => {
            await postDocumentCommand(
              host,
              "name-writer",
              "RenameProject",
              {
                name: odd,
              },
              projectPath,
            );
            await holdFirstProject(guest, token, 1500);
            const studio = await holdChunk(guest, "dawApp");
            await guest.goto(`/r/${token}`, { waitUntil: "commit" });
            await expect(status(guest)).toHaveText(`Loading ${odd}…`, {
              timeout: 8000,
            });
            await fontsReady(guest);
            const before = await headerBoxes(guest);
            studio.release();
            await expect(guest.locator(".stage-frame--guest")).toBeVisible();
            await expect(guest.locator(".sys-header-title")).toHaveText(odd);
            await fontsReady(guest);
            const after = await headerBoxes(guest);
            expect(after.host).toEqual(before.host);
            // A long name ends in an ellipsis at the room the right-hand
            // controls leave, which the loading header does not have yet.
            const compare =
              kind === "120 unbroken characters" ? NOT_WIDTH : ALL;
            near(after.title, before.title, 1, compare);
            await expect(guest.locator(".sys-header-sub")).not.toContainText(
              "Shared link",
            );
            near((await headerBoxes(guest)).title, before.title, 1, compare);
          },
        );
      });
    }

    test("a link the server does not know shows the same loading frame with no name, then the cover", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        const name = await episodeName(guest, token);
        const unknown = `${token.slice(0, -4)}${token.endsWith("aaaa") ? "bbbb" : "aaaa"}`;
        await installProbes(guest);
        await holdFirstProject(guest, unknown, 1500);
        await guest.goto(`/r/${unknown}`, { waitUntil: "commit" });
        await expect(status(guest)).toHaveText("Loading the episode…");
        await expect(guest.locator(".sys-skeleton-block--title")).toBeVisible();
        await expect(guest.locator(".sys-header-title")).toHaveCount(0);
        await expect(
          guest.getByRole("main").getByRole("heading"),
        ).toBeVisible();
        expect(await guest.content()).not.toContain(name);
        const probes = await readProbes(guest);
        expect(probes.titles.map((t) => t.text)).not.toContain(name);
      });
    });

    test("the host's own header still begins on Project, and Home still sets its shell", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (_guest, _token, host) => {
        await installProbes(host);
        await host.reload();
        await expect(host.locator(".stage-frame")).toBeVisible();
        const probes = await readProbes(host);
        expect(probes.titles[0]?.text).toBe("Project");
      });
    });
  });
}

test("the recording room's loading screen keeps its words and its grey header block", async ({
  browser,
}) => {
  await withGuestLink(
    browser,
    SIZES[0],
    async (guest, _token, host, projectPath) => {
      const room = await createRecordRoom(host, projectPath);
      const chunk = await holdChunk(guest, "GuestRoomApp");
      await guest.goto(`/rec/${room.guest.token}`, { waitUntil: "commit" });
      await expect(guest.getByRole("status")).toHaveText("Joining the room…");
      await expect(guest.locator(".sys-skeleton-block--header")).toBeVisible();
      await expect(guest.locator(".sys-app-header-host")).toHaveCount(0);
      chunk.release();
    },
  );
});
