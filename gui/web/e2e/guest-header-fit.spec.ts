import { expect, type Page, test } from "@playwright/test";
import { expectSurfaceAxeClean } from "./axe";
import { fontsReady } from "./fontsReady";
import {
  episodeName,
  holdFirstProject,
  NARROW_PHONE,
  ROLES,
  SIZES,
  type Size,
  withGuestLinks,
  withGuestPage,
} from "./guestLink";
import {
  afterFrames,
  boxesMoved,
  HEADER_HEIGHT,
  headerAcrossLanding,
  headerBoxes,
  headerInventory,
  installProbes,
  landedSettled,
  near,
  openLanded,
  pressTargets,
  type Rect,
  reachingPast,
  readProbes,
  rightSideArrived,
  SHIFT_BUDGET,
  SHOTS_ON,
  shiftSum,
  shot,
  targetProblems,
} from "./guestLoadingProbes";
import { setRootFontSize } from "./rootFontSize";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";

const [PHONE, DESKTOP] = SIZES;
const TOUCH_MIN = 44;
const LANDINGS = 5;
const THEMES = ["light", "dark"] as const;

async function crowdedParts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const host = document.querySelector(".sys-app-header-host")!;
    const parts = [
      host.querySelector(".sys-header-title"),
      host.querySelector(".sys-version"),
      host.querySelector(".sys-save"),
      ...host.querySelectorAll("button"),
    ].filter((el): el is Element => {
      if (!el || el.closest(".sys-coach-tip")) return false;
      const b = el.getBoundingClientRect();
      return b.width > 1 && b.height > 1;
    });
    const text = (el: Element) =>
      el.textContent?.trim().slice(0, 24) || el.getAttribute("aria-label");
    const found: string[] = [];
    for (const [i, a] of parts.entries())
      for (const b of parts.slice(i + 1)) {
        if (a.contains(b) || b.contains(a)) continue;
        const p = a.getBoundingClientRect();
        const q = b.getBoundingClientRect();
        const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
        const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
        if (w > 0.5 && h > 0.5)
          found.push(
            `"${text(a)}" and "${text(b)}" overlap by ${w.toFixed(1)} x ${h.toFixed(1)} px`,
          );
      }
    const cut = [".sys-header-title", ".sys-version .sys-mono"].flatMap(
      (selector) => {
        const el = host.querySelector<HTMLElement>(selector);
        if (!el || el.scrollWidth <= el.clientWidth + 0.5) return [];
        const style = getComputedStyle(el);
        return style.overflow === "hidden" && style.textOverflow === "ellipsis"
          ? []
          : [`${selector} is cut without an ellipsis`];
      },
    );
    return [...found, ...cut];
  });
}

async function nameBox(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      ".sys-app-header-host .sys-header-title",
    )!;
    const b = el.getBoundingClientRect();
    return { w: b.width, cut: el.scrollWidth > el.clientWidth + 0.5 };
  });
}

const loadedFontFaces = (page: Page) =>
  page.evaluate(() =>
    [...document.fonts]
      .filter((face) => face.status === "loaded")
      .map((face) => `${face.family} ${face.weight}`),
  );

const barHeight = (size: Size) =>
  size.touch ? HEADER_HEIGHT.phone : HEADER_HEIGHT.desktop;
const at = (size: Size) => `${size.width}x${size.height}`;
const word = (role: string) => role[0]!.toUpperCase() + role.slice(1);

for (const size of [PHONE, NARROW_PHONE, DESKTOP]) {
  test(`at ${at(size)} nothing in a guest's header reaches the bar's rule, and the bar is ${barHeight(size)} px tall`, async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links, host) => {
      const name = await episodeName(host, links.commenter);
      for (const [visit, roles] of [
        ["returning", ROLES],
        ["first", ["commenter"]],
      ] as const) {
        await withGuestPage(
          browser,
          size,
          async (guest) => {
            for (const role of roles) {
              await openLanded(guest, links[role], name);
              const inventory = await headerInventory(guest);
              const where = `${role}, ${visit} visit`;
              expect
                .soft(inventory.bar.h, `${where}: the bar's height`)
                .toBe(barHeight(size));
              expect
                .soft(
                  reachingPast(inventory),
                  `${where}: what reaches the rule`,
                )
                .toEqual([]);
            }
          },
          { visit },
        );
      }
    });
  });
}

for (const size of [PHONE, NARROW_PHONE]) {
  test(`at ${at(size)} every press target in a guest's header answers over ${TOUCH_MIN} x ${TOUCH_MIN} px inside the bar, clear of the next, and nothing in the header answers a press just under the bar`, async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links, host) => {
      const name = await episodeName(host, links.commenter);
      await withGuestPage(
        browser,
        size,
        async (guest) => {
          for (const role of ROLES) {
            await openLanded(guest, links[role], name);
            const report = await pressTargets(guest, TOUCH_MIN);
            expect
              .soft(
                report.controls.map((control) => control.name),
                `${role}: the buttons found`,
              )
              .toContain(`Explain ${word(role)} role`);
            expect
              .soft(targetProblems(report), `${role}: the press targets`)
              .toEqual([]);
          }
        },
        { visit: "returning" },
      );
    });
  });
}

test(`at ${at(DESKTOP)} the role button answers a press over 32 x 32 px inside the bar, keeps the chip's weight 500, and nothing in the header answers a press just under the bar`, async ({
  browser,
}) => {
  await withGuestLinks(browser, async (links, host) => {
    const name = await episodeName(host, links.commenter);
    await withGuestPage(
      browser,
      DESKTOP,
      async (guest) => {
        for (const role of ROLES) {
          await openLanded(guest, links[role], name);
          const report = await pressTargets(
            guest,
            32,
            'button[aria-label^="Explain"]',
          );
          expect(report.controls, `${role}: the role button`).toHaveLength(1);
          expect
            .soft(targetProblems(report), `${role}: the role button's area`)
            .toEqual([]);
          // The chip's word is weight 500, which it takes from the role button's styles.
          expect
            .soft(
              await guest
                .locator('button[aria-label^="Explain"] .sys-role > span')
                .evaluate((word) => getComputedStyle(word).fontWeight),
              `${role}: the chip's word`,
            )
            .toBe("500");
        }
      },
      { visit: "returning" },
    );
  });
});

for (const size of [PHONE, NARROW_PHONE]) {
  test(`at ${at(size)} the name and the bar keep their boxes from the written page to the loading header to the studio`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    await withGuestLinks(browser, async (links, host) => {
      const name = await episodeName(host, links.commenter);
      for (const role of ["commenter", "editor"] as const) {
        await withGuestPage(
          browser,
          size,
          async (guest) => {
            const run = await headerAcrossLanding(guest, links[role], name);
            const where = `${role} at ${at(size)}`;
            expect
              .soft(run.written.host, `${where}: the written page's bar`)
              .toEqual({ x: 0, y: 0, w: size.width, h: barHeight(size) });
            expect
              .soft(run.drawn.host, `${where}: the loading header's bar`)
              .toEqual(run.written.host);
            expect
              .soft(run.landed.host, `${where}: the studio's bar`)
              .toEqual(run.written.host);
            near(
              run.drawn.title,
              run.written.title,
              1,
              undefined,
              `${where}, loading header:`,
            );
            near(
              run.landed.title,
              run.written.title,
              1,
              undefined,
              `${where}, studio:`,
            );
          },
          { visit: "returning" },
        );
      }
    });
  });
}

test(`at ${at(PHONE)} the name's top and height do not depend on which font has loaded`, async ({
  browser,
}) => {
  await withGuestLinks(browser, async (links, host) => {
    const name = await episodeName(host, links.commenter);
    for (const role of ["commenter", "editor"] as const) {
      let loaded: Rect | null = null;
      await withGuestPage(
        browser,
        PHONE,
        async (guest) => {
          await openLanded(guest, links[role], name);
          // The check below can only see a blocked font if a loaded one shows.
          expect(await loadedFontFaces(guest)).not.toEqual([]);
          loaded = (await headerBoxes(guest)).title;
        },
        { visit: "returning" },
      );
      await withGuestPage(
        browser,
        PHONE,
        async (guest) => {
          await guest.route("**/*.{woff,woff2}", (route) => route.abort());
          await guest.goto(`/r/${links[role]}`);
          await landedSettled(guest, name);
          const blocked = (await headerBoxes(guest)).title;
          expect(
            await loadedFontFaces(guest),
            `${role}: the web fonts the page loaded`,
          ).toEqual([]);
          // The fallback font's line is 17 px where the web font's is 18, so a name
          // whose line depends on the font is off by a pixel in a column that is
          // centred; 0.01 px leaves no room for that.
          near(blocked, loaded, 0.01, ["y", "h"], `${role}, fonts blocked:`);
        },
        { visit: "returning" },
      );
    }
  });
});

for (const size of [PHONE, NARROW_PHONE]) {
  test(`at ${at(size)} an Editor link's landing keeps the bar's height in each of ${LANDINGS} landings, and moves under ${SHIFT_BUDGET}`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    await withGuestLinks(browser, async (links, host) => {
      const name = await episodeName(host, links.editor);
      await withGuestPage(browser, size, async (guest) => {
        await installProbes(guest);
        const runs: unknown[] = [];
        for (let run = 0; run < LANDINGS; run += 1) {
          await holdFirstProject(guest, links.editor, 1500);
          await guest.goto(`/r/${links.editor}`, { waitUntil: "commit" });
          await expect(guest.locator(".sys-header-title")).toBeVisible();
          await fontsReady(guest);
          const loading = (await headerBoxes(guest)).host;
          await landedSettled(guest, name);
          const bar = (await headerBoxes(guest)).host;
          const probes = await readProbes(guest);
          expect
            .soft(
              bar?.h,
              `landing ${run + 1}: the bar after, against ${loading?.h} while loading`,
            )
            .toBe(loading?.h);
          expect(shiftSum(probes), JSON.stringify(probes.shifts)).toBeLessThan(
            SHIFT_BUDGET,
          );
          runs.push({
            sum: shiftSum(probes),
            sources: probes.shifts.flatMap((entry) =>
              entry.sources.map((s) => ({ value: entry.value, ...s })),
            ),
          });
        }
        test.info().annotations.push({
          type: "layout-shift",
          description: JSON.stringify(runs),
        });
      });
    });
  });
}

test(`at ${at(PHONE)} and ${at(NARROW_PHONE)} at 200% text nothing in the header reaches the rule or overlaps, and the name and the version are not cut without an ellipsis`, async ({
  browser,
}) => {
  test.setTimeout(120_000);
  await withGuestLinks(browser, async (links, host) => {
    const name = await episodeName(host, links.commenter);
    for (const size of [PHONE, NARROW_PHONE]) {
      await withGuestPage(
        browser,
        size,
        async (guest) => {
          await openLanded(guest, links.commenter, name);
          await setRootFontSize(guest, 32);
          // Both phones are under 20 rem at 200%: the right side folds into More.
          await expect(guest.locator(".sys-header-short")).toBeVisible();
          await afterFrames(guest);
          const inventory = await headerInventory(guest);
          const where = `commenter at ${at(size)}, root 32 px`;
          expect
            .soft(reachingPast(inventory), `${where}: what reaches the rule`)
            .toEqual([]);
          const crowded = await crowdedParts(guest);
          expect.soft(crowded, `${where}: overlaps and cut text`).toEqual([]);
        },
        { visit: "returning" },
      );
    }
  });
});

// An Editor's second line on the narrowest phone leaves a version button about
// 20 px, the least room it has beside the role button.
for (const [size, role] of [
  [PHONE, "commenter"],
  [NARROW_PHONE, "commenter"],
  [PHONE, "editor"],
  [NARROW_PHONE, "editor"],
] as const) {
  test(`at ${at(size)} a new version's pill and the line it folds into sit in the bar and press over their own area, for ${role === "editor" ? "an Editor" : "a Commenter"} link`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    await withGuestLinks(browser, async (links, host) => {
      const name = await episodeName(host, links.commenter);
      await withGuestPage(
        browser,
        size,
        async (guest) => {
          await openLanded(guest, links[role], name);
          const before = (await headerInventory(guest)).bar.h;
          await guest.route(
            `**/api/review/${links[role]}/project`,
            async (route) => {
              const answer = await route.fetch();
              const body = await answer.json();
              body.review_version = {
                ...body.review_version,
                id: "a-version-the-page-did-not-open-on",
                label: "Intro fix",
              };
              body.link_follows_latest = true;
              await route.fulfill({ response: answer, json: body });
            },
          );
          await guest.evaluate(() => window.dispatchEvent(new Event("focus")));
          const check = async (
            control: ReturnType<Page["getByRole"]>,
            what: string,
          ) => {
            await expect(control).toBeVisible({ timeout: 15_000 });
            await rightSideArrived(guest);
            await afterFrames(guest);
            const inventory = await headerInventory(guest);
            expect
              .soft(inventory.bar.h, `${what}: the bar's height while it shows`)
              .toBe(before);
            expect
              .soft(reachingPast(inventory), `${what}: what reaches the rule`)
              .toEqual([]);
            const report = await pressTargets(guest, TOUCH_MIN);
            expect
              .soft(targetProblems(report), `${what}: the press targets`)
              .toEqual([]);
          };
          await check(
            guest.getByRole("button", { name: /^New version: Intro fix/ }),
            "the pill",
          );
          await check(
            guest.getByRole("button", {
              name: /\. New version: Intro fix\. Listen$/,
            }),
            "the folded line",
          );
        },
        { visit: "returning" },
      );
    });
  });
}

const NAME_FLOOR = 107;
const SUBPIXEL = 0.5;
const LARGE_TEXT = [24, 32] as const;
const TALLEST_BAR = 185;

for (const size of [PHONE, NARROW_PHONE]) {
  test(`at ${at(size)} an Editor's name shows in full, at least 107 px wide`, async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links, host) => {
      const name = await episodeName(host, links.editor);
      await withGuestPage(
        browser,
        size,
        async (guest) => {
          await openLanded(guest, links.editor, name);
          const box = await nameBox(guest);
          expect(box.cut, "the name is cut").toBe(false);
          expect(box.w).toBeGreaterThanOrEqual(NAME_FLOOR - SUBPIXEL);
        },
        { visit: "returning" },
      );
    });
  });
}

for (const size of [PHONE, NARROW_PHONE]) {
  for (const px of LARGE_TEXT) {
    for (const update of [false, true]) {
      test(`at ${at(size)} and ${px} px text an Editor's header ${update ? "with the New version pill " : ""}keeps a name of ${NAME_FLOOR} px, overlaps nothing, stays under ${TALLEST_BAR + 1} px and answers every press`, async ({
        browser,
      }) => {
        test.setTimeout(120_000);
        await withGuestLinks(browser, async (links, host) => {
          const name = await episodeName(host, links.editor);
          await withGuestPage(
            browser,
            size,
            async (guest) => {
              await openLanded(guest, links.editor, name);
              if (update) {
                await guest.route(
                  `**/api/review/${links.editor}/project`,
                  async (route) => {
                    const answer = await route.fetch();
                    const body = await answer.json();
                    body.review_version = {
                      ...body.review_version,
                      id: "a-version-the-page-did-not-open-on",
                      label: "Intro fix",
                    };
                    body.link_follows_latest = true;
                    await route.fulfill({ response: answer, json: body });
                  },
                );
                await guest.evaluate(() =>
                  window.dispatchEvent(new Event("focus")),
                );
                await expect(
                  guest.getByRole("button", {
                    name: /^New version: Intro fix/,
                  }),
                ).toBeVisible({ timeout: 15_000 });
              }
              await setRootFontSize(guest, px);
              await afterFrames(guest);
              const where = `Editor at ${at(size)}, root ${px} px${update ? ", pill" : ""}`;
              expect
                .soft((await nameBox(guest)).w, `${where}: the name's width`)
                .toBeGreaterThanOrEqual(NAME_FLOOR - SUBPIXEL);
              expect
                .soft(
                  await crowdedParts(guest),
                  `${where}: overlaps and cut text`,
                )
                .toEqual([]);
              const inventory = await headerInventory(guest);
              expect
                .soft(inventory.bar.h, `${where}: the bar's height`)
                .toBeLessThanOrEqual(TALLEST_BAR);
              expect
                .soft(
                  reachingPast(inventory),
                  `${where}: what reaches the rule`,
                )
                .toEqual([]);
              const report = await pressTargets(guest, TOUCH_MIN);
              expect
                .soft(targetProblems(report), `${where}: the press targets`)
                .toEqual([]);
            },
            { visit: "returning" },
          );
        });
      });
    }
  }
}

for (const size of [PHONE, NARROW_PHONE]) {
  test(`at ${at(size)} every press area in an Editor's header is at least ${TOUCH_MIN} px wide, the version control's with the New version pill included`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    await withGuestLinks(browser, async (links, host) => {
      const name = await episodeName(host, links.editor);
      await withGuestPage(
        browser,
        size,
        async (guest) => {
          await openLanded(guest, links.editor, name);
          await guest.route(
            `**/api/review/${links.editor}/project`,
            async (route) => {
              const answer = await route.fetch();
              const body = await answer.json();
              body.review_version = {
                ...body.review_version,
                id: "a-version-the-page-did-not-open-on",
                label: "Intro fix",
              };
              body.link_follows_latest = true;
              await route.fulfill({ response: answer, json: body });
            },
          );
          await guest.evaluate(() => window.dispatchEvent(new Event("focus")));
          const pill = guest.getByRole("button", {
            name: /^New version: Intro fix/,
          });
          await expect(pill).toBeVisible({ timeout: 15_000 });
          await afterFrames(guest);
          const report = await pressTargets(guest, TOUCH_MIN);
          expect
            .soft(
              report.controls.map((control) => control.name),
              "the version control is among the buttons found",
            )
            .toContainEqual(expect.stringMatching(/^New version: Intro fix/));
          expect
            .soft(
              report.controls
                .filter((control) => control.area.w < TOUCH_MIN - 0.5)
                .map((control) => `${control.name}: ${control.area.w}`),
              "the press areas under the touch minimum",
            )
            .toEqual([]);
        },
        { visit: "returning" },
      );
    });
  });
}

for (const size of [PHONE, NARROW_PHONE]) {
  test(`at ${at(size)} the rows the fold reserves for the Edit stage are within 1 px of the rows the stage measures`, async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links, host) => {
      const name = await episodeName(host, links.editor);
      await withGuestPage(
        browser,
        size,
        async (guest) => {
          await openLanded(guest, links.editor, name);
          const heights = await guest.evaluate(() => {
            const root = document.documentElement;
            const folded = "frameShort" in root.dataset;
            if (folded) delete root.dataset.frameShort;
            const frame = document.querySelector<HTMLElement>(
              ".stage-frame--guest",
            )!;
            const token = (name: string) => {
              const probe = document.createElement("div");
              probe.style.cssText = `position:absolute;visibility:hidden;inline-size:0;block-size:var(${name})`;
              frame.appendChild(probe);
              const h = probe.getBoundingClientRect().height;
              probe.remove();
              return h;
            };
            const height = (selector: string) =>
              frame.querySelector(selector)?.getBoundingClientRect().height ??
              0;
            const out = {
              reservedRows: token("--phone-edit-rows-height"),
              rows: height(".phone-edit-bar") + height(".edit-dock"),
              reservedCorner: token("--phone-edit-corner-height"),
              corner: height(".edit-workspace .edit-corner"),
            };
            if (folded) root.dataset.frameShort = "";
            return out;
          });
          expect(heights.rows).toBeGreaterThan(0);
          expect(
            Math.abs(heights.reservedRows - heights.rows),
            JSON.stringify(heights),
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs(heights.reservedCorner - heights.corner),
            JSON.stringify(heights),
          ).toBeLessThanOrEqual(1);
        },
        { visit: "returning" },
      );
    });
  });
}

test(`at ${at(PHONE)} axe finds nothing in the landed header of the three roles, and the role has its names (light and dark)`, async ({
  browser,
}) => {
  await withGuestLinks(browser, async (links, host) => {
    const name = await episodeName(host, links.commenter);
    for (const theme of THEMES) {
      await withGuestPage(
        browser,
        PHONE,
        async (guest) => {
          await guest.emulateMedia({ colorScheme: theme });
          for (const role of ROLES) {
            await openLanded(guest, links[role], name);
            await expect(
              guest.getByRole("button", { name: `Explain ${word(role)} role` }),
            ).toBeVisible();
            await expect(
              guest.getByRole("img", {
                name: new RegExp(`^${word(role)}: can `),
              }),
            ).toBeVisible();
            await expectSurfaceAxeClean(guest, ".sys-app-header-host");
          }
        },
        { visit: "returning" },
      );
    }
  });
});

/**
 * The header controls' boxes on develop, 04fc34d5: the host's, and a guest's on
 * a desktop. The host is alone in its project, with no guest connected: a guest's
 * avatar on the right takes 44 px of the phone's row, so a host with one has its
 * Undo and Redo 44 px further left (x 138 and 182).
 */
const DEVELOP: Record<string, Record<string, Rect>> = {
  "host phone": {
    bar: { x: 0, y: 0, w: 390, h: 45 },
    project: { x: 8, y: 0, w: 150, h: 44 },
    undo: { x: 182, y: 0, w: 44, h: 44 },
    redo: { x: 226, y: 0, w: 44, h: 44 },
  },
  "host desktop": {
    bar: { x: 0, y: 0, w: 1280, h: 49 },
    project: { x: 16, y: 8, w: 150.875, h: 32 },
    undo: { x: 198.875, y: 8, w: 32, h: 32 },
    redo: { x: 230.875, y: 8, w: 32, h: 32 },
  },
  "guest commenter": {
    bar: { x: 0, y: 0, w: 1280, h: 49 },
    appearance: { x: 624, y: 9, w: 32, h: 32 },
    palette: { x: 664, y: 9, w: 32, h: 32 },
    people: { x: 584, y: 9, w: 32, h: 32 },
  },
  "guest editor": {
    bar: { x: 0, y: 0, w: 1280, h: 49 },
    undo: { x: 214.515625, y: 9, w: 32, h: 32 },
    redo: { x: 246.515625, y: 9, w: 32, h: 32 },
    appearance: { x: 1192, y: 9, w: 32, h: 32 },
    palette: { x: 1232, y: 9, w: 32, h: 32 },
    people: { x: 1152, y: 9, w: 32, h: 32 },
  },
};

async function controlBoxes(page: Page, selectors: Record<string, string>) {
  return page.evaluate((wanted) => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> =
      {};
    const header = document.querySelector(".sys-app-header-host");
    for (const [label, selector] of Object.entries(wanted)) {
      // ":scope" is the header itself; the rest are looked up inside it.
      const r = (
        selector === ":scope" ? header : header?.querySelector(selector)
      )?.getBoundingClientRect();
      if (r) out[label] = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return out;
  }, selectors);
}

const HOST_CONTROLS = {
  bar: ":scope",
  project: ".sys-header-project",
  undo: 'button[aria-label="Undo"]',
  redo: 'button[aria-label="Redo"]',
};
const GUEST_CONTROLS = {
  bar: ":scope",
  undo: 'button[aria-label="Undo"]',
  redo: 'button[aria-label="Redo"]',
  appearance: 'button[aria-label="Appearance"]',
  palette: 'button[aria-label="Palette"]',
  people: ".sys-header-right .avatar-face",
};

for (const size of [PHONE, DESKTOP]) {
  test(`at ${at(size)} the host's header keeps the boxes it has on develop`, async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      await withGuestPage(browser, size, async (hostPage) => {
        await openHostShare(hostPage, projectPath);
        await expect(hostPage.locator(".sys-header-project")).toBeVisible();
        await afterFrames(hostPage);
        const boxes = await controlBoxes(hostPage, HOST_CONTROLS);
        expect(
          boxesMoved(boxes, DEVELOP[`host ${size.name}`] ?? {}, 0.5),
        ).toEqual([]);
      });
    });
  });
}

test(`at ${at(DESKTOP)} a guest's controls keep their boxes on develop, except the x of Undo and Redo`, async ({
  browser,
}) => {
  await withGuestLinks(browser, async (links, host) => {
    const name = await episodeName(host, links.commenter);
    await withGuestPage(
      browser,
      DESKTOP,
      async (guest) => {
        for (const role of ["commenter", "editor"] as const) {
          await openLanded(guest, links[role], name);
          const boxes = await controlBoxes(guest, GUEST_CONTROLS);
          const { bar: barBox, ...controls } = boxes;
          const { bar: wasBar, ...was } = DEVELOP[`guest ${role}`] ?? {};
          expect
            .soft(
              boxesMoved({ bar: barBox! }, { bar: wasBar! }, 0),
              `${role}: the bar`,
            )
            .toEqual([]);
          // Undo and Redo sit after the role button, whose width is its chip's,
          // so only their row and size are held.
          for (const label of ["undo", "redo"] as const)
            if (controls[label] && was[label]) controls[label].x = was[label].x;
          expect
            .soft(boxesMoved(controls, was, 1), `${role}: the controls`)
            .toEqual([]);
        }
      },
      { visit: "returning" },
    );
  });
});

test.describe("pictures of the header for a person to judge", () => {
  test.skip(!SHOTS_ON, "set GUEST_LOADING_SHOTS to a folder to save them");

  for (const size of [PHONE, NARROW_PHONE]) {
    test(`pictures of the top of the header at ${at(size)}, three roles, both themes, first and returning, and at 200% text are filed`, async ({
      browser,
    }) => {
      test.setTimeout(300_000);
      const prefix = `phone${size.width}`;
      const strip: Rect = { x: 0, y: 0, w: size.width, h: 160 };
      await withGuestLinks(browser, async (links, host) => {
        const name = await episodeName(host, links.commenter);
        for (const visit of ["first", "returning"] as const) {
          for (const theme of THEMES) {
            await withGuestPage(
              browser,
              size,
              async (guest) => {
                await guest.emulateMedia({ colorScheme: theme });
                for (const role of ROLES) {
                  await openLanded(guest, links[role], name);
                  await shot(
                    guest,
                    `${prefix}-${role}-${theme}-${visit}`,
                    strip,
                  );
                  if (role !== "commenter") continue;
                  await setRootFontSize(guest, 32);
                  await afterFrames(guest);
                  await shot(
                    guest,
                    `${prefix}-${role}-${theme}-${visit}-200pct`,
                    strip,
                  );
                }
              },
              { visit, scale: 2 },
            );
          }
        }
      });
    });
  }
});
