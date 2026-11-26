import { devices, expect, type Page, test } from "@playwright/test";
import { emit } from "./storyChannel";
import { storyUrl } from "./storyUrl";

async function settled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
}

/**
 * The remote playhead's flag on the ruler (#2919): a pill with the person's
 * initial that fades the ruler label it touches, merges with its neighbours
 * into one `+N` pill that opens a menu of people, and is a real button as big
 * as the press area. jsdom has no CSS, so the boxes, the fade and the
 * pointer routing are measured here in Chromium, at 900 px with a mouse and at
 * 390 px with a finger.
 */

const FLOOR_PX = 44 - 0.5;

// A describe group cannot switch the browser type, so the phone keeps the rest of the Pixel 5 emulation: the touch screen and the coarse pointer.
const { defaultBrowserType: _browser, ...PIXEL_5 } = devices["Pixel 5"];

type Story = { id: string; args?: Record<string, unknown> };

const PRESENCE = (name: string) => `system-presence--${name}`;
const TIMELINE = (name: string) => `stages-edit-timeline--${name}`;

async function open(
  page: Page,
  id: string,
  options: {
    scheme?: "light" | "dark";
    motion?: "reduce" | "no-preference";
    forced?: boolean;
  } = {},
) {
  await page.emulateMedia({
    colorScheme: options.scheme ?? "light",
    reducedMotion: options.motion ?? "reduce",
    forcedColors: options.forced ? "active" : "none",
  });
  await page.goto(storyUrl(id, { theme: options.scheme ?? "light" }));
  await expect(page.locator(".sys-presence")).toBeAttached();
}

const update = (page: Page, story: Story) =>
  emit(page, "updateStoryArgs", {
    storyId: story.id,
    updatedArgs: story.args,
  });

const label = (page: Page, text: string) =>
  page.locator(".sys-ruler-tick-label", { hasText: new RegExp(`^${text}$`) });

const pills = (page: Page) => page.locator("button.sys-presence-hit");

async function box(locator: ReturnType<Page["locator"]>) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on screen");
  return found;
}

async function hitAt(page: Page, x: number, y: number) {
  return page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py);
      return {
        pill: el?.closest("button.sys-presence-hit") !== null,
        overlay: el?.closest(".sys-presence") !== null,
        ruler: el?.closest(".sys-ruler-body") !== null,
        marker: el?.closest(".sys-marker-hit") !== null,
        clip: el?.closest(".sys-clip") !== null,
      };
    },
    [x, y] as const,
  );
}

const went = (page: Page) =>
  page.locator("[data-went]").first().getAttribute("data-went");

function suite(name: string, width: number, touch: boolean) {
  test.describe(`${name} (${width} px)`, () => {
    test.use(
      touch
        ? { ...PIXEL_5, viewport: { width, height: 844 } }
        : { viewport: { width, height: 800 } },
    );

    test("a ruler label under a flag fades, and the same label comes back, in the same place, when the flag moves on", async ({
      page,
    }) => {
      await open(page, PRESENCE("flag-over-label"), {
        motion: "no-preference",
      });
      const covered = label(page, "0:05");
      await expect(covered).toHaveAttribute("data-covered", "");
      await expect(covered).toHaveCSS("opacity", "0");
      await expect(covered).toHaveCSS("transition-duration", "0.15s");
      await expect(label(page, "0:00")).toHaveCSS("opacity", "1");
      await expect(label(page, "0:10")).toHaveCSS("opacity", "1");
      const before = await box(covered);
      await update(page, {
        id: PRESENCE("flag-over-label"),
        args: {
          people: [
            { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 7 },
          ],
        },
      });
      await expect(covered).not.toHaveAttribute("data-covered");
      await expect(covered).toHaveCSS("opacity", "1");
      expect(await box(covered)).toEqual(before);
      await expect(page.locator(".sys-presence-line")).toHaveCount(1);
    });

    test("under reduced motion the fade is instant in both directions", async ({
      page,
    }) => {
      await open(page, PRESENCE("flag-over-label"), { motion: "reduce" });
      const covered = label(page, "0:05");
      await expect(covered).toHaveCSS("transition-duration", "0s");
      await expect(covered).toHaveCSS("opacity", "0");
      await update(page, {
        id: PRESENCE("flag-over-label"),
        args: {
          people: [
            { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 7 },
          ],
        },
      });
      const opacity = await covered.evaluate(
        (el) =>
          new Promise<string>((resolve) => {
            const poll = () =>
              el.hasAttribute("data-covered")
                ? requestAnimationFrame(poll)
                : resolve(getComputedStyle(el).opacity);
            poll();
          }),
      );
      expect(opacity).toBe("1");
    });

    test("people whose press areas touch merge into one +N pill, and moving them apart gives each their flag back", async ({
      page,
    }) => {
      await open(page, PRESENCE("cluster"));
      await expect(page.locator(".sys-presence-line")).toHaveCount(3);
      await expect(page.locator(".sys-presence-flag")).toHaveCount(1);
      await expect(page.locator(".sys-presence-flag")).toHaveText("+3");
      const colors = await page
        .locator(".sys-presence-person")
        .evaluateAll((els) =>
          els.map(
            (el) =>
              getComputedStyle(el.firstElementChild!).borderInlineStartColor,
          ),
        );
      expect(new Set(colors).size).toBe(3);
      await update(page, {
        id: PRESENCE("cluster"),
        args: {
          people: [
            { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 3 },
            {
              id: "anneke",
              name: "Anneke de Vries",
              colorIndex: 1,
              playhead: 8,
            },
            { id: "leo", name: "Leo Brandt", colorIndex: 2, playhead: 14 },
          ],
        },
      });
      await expect(page.locator(".sys-presence-flag")).toHaveCount(3);
      await expect(page.locator(".sys-presence-flag")).toHaveText([
        "M",
        "A",
        "L",
      ]);
    });

    test(`two people one second apart (24 px) are ${touch ? "merged for a finger (44 px press area)" : "two flags for a mouse (24 px press area)"}`, async ({
      page,
    }) => {
      await open(page, PRESENCE("two-remote"));
      await update(page, {
        id: PRESENCE("two-remote"),
        args: {
          people: [
            { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 8 },
            {
              id: "anneke",
              name: "Anneke de Vries",
              colorIndex: 1,
              playhead: 9,
            },
          ],
        },
      });
      await expect(page.locator(".sys-presence-flag")).toHaveCount(
        touch ? 1 : 2,
      );
    });

    test("the flag is a real button whose own box is the press area, and no two press areas overlap", async ({
      page,
    }) => {
      await open(page, PRESENCE("two-remote"));
      const buttons = pills(page);
      await expect(buttons).toHaveCount(2);
      const boxes = [await box(buttons.nth(0)), await box(buttons.nth(1))];
      const side = touch ? FLOOR_PX : 24 - 0.5;
      for (const found of boxes) {
        expect(found.width).toBeGreaterThanOrEqual(side);
        expect(found.height).toBeGreaterThanOrEqual(side);
      }
      expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x);
      await expect(buttons.first()).toHaveCSS("touch-action", "manipulation");
      await expect(buttons.first()).toHaveAttribute("tabindex", "-1");
      const pill = await box(page.locator(".sys-presence-flag").first());
      expect([pill.width, pill.height]).toEqual([16, 16]);
      const first = boxes[0]!;
      expect(pill.x).toBeGreaterThanOrEqual(first.x);
      expect(pill.x + pill.width).toBeLessThanOrEqual(first.x + first.width);
    });

    test("a press inside the box goes to the flag and not to the ruler under it, and a press outside it still reaches the ruler", async ({
      page,
    }) => {
      await open(page, PRESENCE("two-remote"));
      const found = await box(pills(page).first());
      const ruler = await box(page.locator(".sys-ruler-body"));
      const y = ruler.y + 12;
      expect(
        (
          await hitAt(
            page,
            found.x + found.width / 2,
            found.y + found.height - 2,
          )
        ).pill,
      ).toBe(true);
      expect((await hitAt(page, found.x + 2, y)).pill).toBe(true);
      const outside = await hitAt(page, found.x - 4, y);
      expect(outside.pill).toBe(false);
      expect(outside.ruler).toBe(true);
    });

    test("a tap on a single flag jumps to that person", async ({ page }) => {
      await open(page, PRESENCE("two-remote"));
      const found = await box(pills(page).first());
      const x = found.x + found.width / 2;
      const y = found.y + found.height / 2;
      if (touch) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
      expect(await went(page)).toBe("maya");
    });

    test("a flag nobody can jump to is a plain mark: no button, and the pointer passes through it", async ({
      page,
    }) => {
      await open(page, PRESENCE("guest-plain-marks"));
      await expect(page.locator(".sys-presence-flag")).toHaveCount(2);
      await expect(pills(page)).toHaveCount(0);
      const found = await box(page.locator(".sys-presence-flag").first());
      const hit = await hitAt(page, found.x + 8, found.y + 8);
      expect(hit.overlay).toBe(false);
    });

    test("the +N menu lists the people beside the overlay, every row is reachable, and choosing one closes it", async ({
      page,
    }) => {
      await open(page, TIMELINE("cluster"));
      const pill = pills(page);
      await expect(pill).toHaveText("+3");
      await pill.click();
      const menu = page.getByRole("menu", { name: "3 people near 0:06" });
      await expect(menu).toBeVisible();
      await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>(
          ".timeline-presence-menu",
        );
        if (root?.parentElement)
          root.parentElement.style.pointerEvents = "none";
      });
      expect(
        await menu.evaluate(
          (el) => el.closest("[aria-hidden='true']") === null,
        ),
      ).toBe(true);
      const rows = menu.getByRole("menuitem");
      await expect(rows).toHaveCount(3);
      for (let i = 0; i < 3; i++) {
        const row = await box(rows.nth(i));
        expect(row.height).toBeGreaterThanOrEqual(touch ? FLOOR_PX : 32);
        const viewport = page.viewportSize()!;
        expect(row.x).toBeGreaterThanOrEqual(0);
        expect(row.x + row.width).toBeLessThanOrEqual(viewport.width);
        expect(row.y + row.height).toBeLessThanOrEqual(viewport.height);
        const reached = await page.evaluate(
          ([x, y]) =>
            document.elementFromPoint(x, y)?.closest("[role=menuitem]")
              ?.textContent ?? null,
          [row.x + row.width / 2, row.y + row.height / 2] as const,
        );
        expect(reached).toBe(await rows.nth(i).textContent());
      }
      await expect(rows).toHaveText([
        /Maya Okafor.*0:06/,
        /Anneke de Vries.*0:06/,
        /Leo Brandt.*0:07/,
      ]);
      await rows.nth(1).click();
      await expect(menu).toBeHidden();
    });

    test("the +N menu closes on Escape and on a press outside, and a press on its own pill closes it", async ({
      page,
    }) => {
      await open(page, TIMELINE("cluster"));
      const pill = pills(page);
      await pill.click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await pill.click();
      await expect(menu).toBeVisible();
      const found = await box(pill);
      const centre = [
        found.x + found.width / 2,
        found.y + found.height / 2,
      ] as const;
      await page.mouse.click(...centre);
      await expect(menu).toBeHidden();
      await pill.click();
      await expect(menu).toBeVisible();
      await page.mouse.click(2, page.viewportSize()!.height - 2);
      await expect(menu).toBeHidden();
    });

    test("while the +N menu is open its unseen trigger sits exactly over the pill and reaches the whole press area, hidden from a virtual cursor", async ({
      page,
    }) => {
      await open(page, TIMELINE("cluster"));
      await pills(page).click();
      await expect(page.getByRole("menu")).toBeVisible();
      const hit = await box(pills(page));
      const flag = await box(page.locator(".sys-presence-flag--group"));
      const anchor = page.locator(".timeline-presence-anchor");
      await expect(anchor).toHaveAttribute("aria-hidden", "true");
      const over = await box(anchor);
      expect(over.x).toBeCloseTo(flag.x, 0);
      expect(over.y).toBeCloseTo(flag.y, 0);
      expect(over.width).toBeCloseTo(flag.width, 0);
      expect(over.height).toBeCloseTo(flag.height, 0);
      for (const [x, y] of [
        [hit.x + 2, hit.y + 2],
        [hit.x + hit.width - 2, hit.y + 2],
        [flag.x + flag.width / 2, flag.y + flag.height / 2],
      ] as const) {
        expect(
          await page.evaluate(
            ([px, py]) => {
              const found = document.elementFromPoint(px, py);
              return found?.classList.contains("timeline-presence-anchor")
                ? "anchor"
                : `${found?.tagName}.${found?.className}`;
            },
            [x, y] as const,
          ),
        ).toBe("anchor");
      }
    });

    test("a press in the box beside the pill closes the open menu and does not reopen it", async ({
      page,
    }) => {
      await open(page, TIMELINE("cluster"));
      const hit = await box(pills(page));
      await pills(page).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await page.mouse.click(hit.x + 2, hit.y + hit.height - 2);
      await expect(menu).toBeHidden();
      await settled(page);
      await expect(menu).toBeHidden();
    });

    test("the press area stops above the first lane at twice the text size", async ({
      page,
    }) => {
      await open(page, TIMELINE("cluster"));
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
        window.dispatchEvent(new Event("resize"));
      });
      await settled(page);
      const found = await box(pills(page));
      const ruler = await box(page.locator(".sys-ruler"));
      const lane = await box(page.locator(".sys-lane").first());
      expect(found.y + found.height).toBeLessThanOrEqual(lane.y + 0.5);
      expect(found.height).toBeLessThanOrEqual(48.5);
      expect(found.y).toBeCloseTo(ruler.y, 0);
    });

    test("the group pill draws its normal-colour border from the strong border token", async ({
      page,
    }) => {
      await open(page, TIMELINE("cluster"));
      const group = page.locator(".sys-presence-flag--group");
      await expect(group).toHaveCSS("border-top-width", "1px");
      await expect(group).toHaveCSS("border-top-style", "solid");
      const token = await page.evaluate(() => {
        const probe = document.createElement("i");
        probe.style.border = "1px solid var(--color-border-strong)";
        document.body.append(probe);
        const color = getComputedStyle(probe).borderTopColor;
        probe.remove();
        return color;
      });
      await expect(group).toHaveCSS("border-top-color", token);
    });

    test("a link that cannot open where they are draws the +N flag as a plain mark with no menu", async ({
      page,
    }) => {
      await open(page, TIMELINE("guest-cluster"));
      await expect(page.locator(".sys-presence-flag")).toHaveText("+2");
      await expect(pills(page)).toHaveCount(0);
    });

    test("a clip tap beside a person's line, below the ruler and the marker row, still selects the clip", async ({
      page,
    }) => {
      await open(page, TIMELINE("cluster"));
      const line = await box(page.locator(".sys-presence-line").first());
      const clip = page.locator('.sys-clip[data-clip-id="Maya, intro"]');
      const found = await box(clip);
      const x = line.x + 2;
      expect(x).toBeLessThan(found.x + found.width);
      const y = found.y + found.height - 6;
      expect((await hitAt(page, x, y)).clip).toBe(true);
      if (touch) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
      await expect(clip).toHaveAttribute("data-selected", "true");
    });

    test("a marker away from every flag keeps its press, and the press area ends above the first lane", async ({
      page,
    }) => {
      await open(page, TIMELINE("cluster"));
      const marker = await box(page.locator(".sys-marker-hit").first());
      expect(
        (
          await hitAt(
            page,
            marker.x + marker.width / 2,
            marker.y + marker.height / 2,
          )
        ).marker,
      ).toBe(true);
      const found = await box(pills(page));
      const ruler = await box(page.locator(".sys-ruler"));
      expect(found.y + found.height).toBeLessThanOrEqual(
        ruler.y + (touch ? 44 : 24) + 0.5,
      );
      const lane = await box(page.locator(".sys-lane").first());
      expect(found.y + found.height).toBeLessThanOrEqual(lane.y);
    });

    test("under forced colours a single flag has a border too", async ({
      page,
    }) => {
      await open(page, PRESENCE("two-remote"), { forced: true });
      const single = page.locator(
        ".sys-presence-flag:not(.sys-presence-flag--group)",
      );
      await expect(single.first()).toBeVisible();
      await expect(single.first()).toHaveCSS("border-top-width", "1px");
      await expect(single.first()).toHaveCSS("border-top-style", "solid");
    });

    test("under forced colours the flag has a border, the hover ring is an outline and the menu's dot is a border", async ({
      page,
    }) => {
      await open(page, TIMELINE("cluster"), { forced: true });
      const pill = page.locator(".sys-presence-flag").first();
      await expect(pill).toHaveCSS("border-top-width", "1px");
      await expect(pill).toHaveCSS("border-top-style", "solid");
      await expect(pill).toHaveCSS("box-shadow", "none");
      if (!touch) {
        await pills(page).hover();
        await expect(pill).toHaveCSS("outline-style", "solid");
        await expect(pill).toHaveCSS("outline-width", "1px");
      }
      await pills(page).click();
      const dot = page.locator(".timeline-presence-dot").first();
      await expect(dot).toHaveCSS("border-top-width", "4px");
      await expect(dot).toHaveCSS("background-color", /, 0\)$/);
    });
  });
}

suite("desktop", 900, false);
suite("phone", 390, true);

test.describe("phone gestures", () => {
  test.use({ ...PIXEL_5, viewport: { width: 390, height: 844 } });

  async function swipe(page: Page, from: { x: number; y: number }, dx: number) {
    const session = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number) =>
      session.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y: from.y }],
      });
    await touch("touchStart", from.x);
    for (let step = 1; step <= 8; step++) {
      await touch("touchMove", from.x + (dx * step) / 8);
    }
    await touch("touchEnd", from.x + dx);
    await session.detach();
  }

  test("a pan that starts on a flag does not jump", async ({ page }) => {
    await open(page, PRESENCE("two-remote"));
    const found = await box(pills(page).first());
    await swipe(
      page,
      { x: found.x + found.width / 2, y: found.y + found.height / 2 },
      -90,
    );
    await settled(page);
    expect(await went(page)).toBe("");
  });
});

test.describe("both themes", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`the single and +N flags draw in ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 600 });
      await open(page, PRESENCE("cluster"), { scheme });
      const group = page.locator(".sys-presence-flag").first();
      await expect(group).toHaveText("+3");
      const colors = await group.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          border: style.borderTopColor,
          fill: style.backgroundColor,
          ink: style.color,
        };
      });
      expect(colors.fill).not.toBe(colors.border);
      expect(colors.ink).not.toBe(colors.fill);
    });
  }
});
