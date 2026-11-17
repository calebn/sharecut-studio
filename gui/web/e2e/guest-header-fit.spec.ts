import { expect, type Page, test } from "@playwright/test";
import { expectSurfaceAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
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
  landed,
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
/** Short enough to fit the room an Editor's name has beside Undo and Redo on the narrowest phone. */
const SHORT_NAME = "Pilot";

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
  test(`at ${at(size)} every press target in a guest's header is ${TOUCH_MIN} px square, inside the bar, and clear of the next`, async ({
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

test(`at ${at(DESKTOP)} the role button answers a press over 32 px of height, inside the bar`, async ({
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
    await withGuestLinks(browser, async (links, host, projectPath) => {
      await postDocumentCommand(
        host,
        "name-writer",
        "RenameProject",
        { name: SHORT_NAME },
        projectPath,
      );
      for (const role of ["commenter", "editor"] as const) {
        await withGuestPage(
          browser,
          size,
          async (guest) => {
            const run = await headerAcrossLanding(
              guest,
              links[role],
              SHORT_NAME,
            );
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

test(`at ${at(PHONE)} the name's place does not depend on which font has loaded`, async ({
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
          await landed(guest, name);
          await rightSideArrived(guest);
          await afterFrames(guest);
          const blocked = (await headerBoxes(guest)).title;
          near(blocked, loaded, 1, ["y"], `${role}, fonts blocked:`);
        },
        { visit: "returning" },
      );
    }
  });
});

test(`at ${at(PHONE)} an Editor link's landing moves under ${SHIFT_BUDGET} in each of ${LANDINGS} landings`, async ({
  browser,
}) => {
  test.setTimeout(120_000);
  await withGuestLinks(browser, async (links, host) => {
    const name = await episodeName(host, links.editor);
    await withGuestPage(browser, PHONE, async (guest) => {
      await installProbes(guest);
      for (let run = 0; run < LANDINGS; run += 1) {
        await holdFirstProject(guest, links.editor, 1500);
        await guest.goto(`/r/${links.editor}`, { waitUntil: "commit" });
        await landed(guest, name);
        await rightSideArrived(guest);
        await afterFrames(guest);
        const probes = await readProbes(guest);
        expect(shiftSum(probes), JSON.stringify(probes.shifts)).toBeLessThan(
          SHIFT_BUDGET,
        );
      }
    });
  });
});

test(`at ${at(NARROW_PHONE)} an Editor link's landing is measured: the bar keeps its height, and what shifts is printed`, async ({
  browser,
}) => {
  test.setTimeout(120_000);
  await withGuestLinks(browser, async (links, host) => {
    const name = await episodeName(host, links.editor);
    await withGuestPage(browser, NARROW_PHONE, async (guest) => {
      await installProbes(guest);
      const runs: unknown[] = [];
      for (let run = 0; run < LANDINGS; run += 1) {
        await holdFirstProject(guest, links.editor, 1500);
        await guest.goto(`/r/${links.editor}`, { waitUntil: "commit" });
        await expect(guest.locator(".sys-header-title")).toBeVisible();
        await fontsReady(guest);
        const loading = (await headerBoxes(guest)).host;
        await landed(guest, name);
        await rightSideArrived(guest);
        await afterFrames(guest);
        const bar = (await headerBoxes(guest)).host;
        const probes = await readProbes(guest);
        runs.push({
          sum: shiftSum(probes),
          sources: probes.shifts.flatMap((entry) =>
            entry.sources.map((s) => ({ value: entry.value, ...s })),
          ),
        });
        expect
          .soft(
            bar?.h,
            `landing ${run + 1}: the bar after, against ${loading?.h} while loading`,
          )
          .toBe(loading?.h);
      }
      test.info().annotations.push({
        type: "layout-shift",
        description: JSON.stringify(runs),
      });
    });
  });
});

test(`at ${at(PHONE)} and ${at(NARROW_PHONE)} at 200% text nothing in the header overlaps or is cut without an ellipsis`, async ({
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
          await afterFrames(guest);
          const inventory = await headerInventory(guest);
          const where = `commenter at ${at(size)}, root 32 px`;
          expect
            .soft(reachingPast(inventory), `${where}: what reaches the rule`)
            .toEqual([]);
          const crowded = await guest.evaluate(() => {
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
              el.textContent?.trim().slice(0, 24) ||
              el.getAttribute("aria-label");
            const found: string[] = [];
            for (const [i, a] of parts.entries())
              for (const b of parts.slice(i + 1)) {
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
                return style.overflow === "hidden" &&
                  style.textOverflow === "ellipsis"
                  ? []
                  : [`${selector} is cut without an ellipsis`];
              },
            );
            return [...found, ...cut];
          });
          expect.soft(crowded, `${where}: overlaps and cut text`).toEqual([]);
        },
        { visit: "returning" },
      );
    }
  });
});

for (const size of [PHONE, NARROW_PHONE]) {
  test(`at ${at(size)} a new version's pill and the line it folds into sit in the bar and press over their own area`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    await withGuestLinks(browser, async (links, host) => {
      const name = await episodeName(host, links.commenter);
      await withGuestPage(
        browser,
        size,
        async (guest) => {
          await openLanded(guest, links.commenter, name);
          const before = (await headerInventory(guest)).bar.h;
          await guest.route(
            `**/api/review/${links.commenter}/project`,
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

/** The header controls' boxes on develop, 04fc34d5: the host's, and a guest's on a desktop. */
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
    for (const [label, selector] of Object.entries(wanted)) {
      const r = document.querySelector(selector)?.getBoundingClientRect();
      if (r) out[label] = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return out;
  }, selectors);
}

const HOST_CONTROLS = {
  bar: ".sys-app-header-host",
  project: ".sys-header-project",
  undo: 'button[aria-label="Undo"]',
  redo: 'button[aria-label="Redo"]',
};
const GUEST_CONTROLS = {
  bar: ".sys-app-header-host",
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

test(`at ${at(DESKTOP)} a guest's controls keep the boxes they have on develop, to the pixel their row grew`, async ({
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
    test(`the top of the header at ${at(size)}, three roles, both themes, first and returning, and at 200% text`, async ({
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
