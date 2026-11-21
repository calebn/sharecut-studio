import { expect, type Locator, type Page, test } from "@playwright/test";
import { openHome } from "./home";
import {
  expectNoHorizontalScroll,
  expectTouchTargets,
  mockBootstrap,
  type ModelRow,
  prepare,
  shot,
} from "./modelsMock";
import { setRootFontSize } from "./rootFontSize";

/** The Models sheet and Home Setup card on an iPhone host (whisper.cpp), at phone width and under text zoom. */

const PHONE_WHISPER: ModelRow = {
  id: "whisper",
  label: "Whisper",
  purpose: "transcription",
  tier: "required",
  model: "small.en-q5_1",
  size: "190 MB",
  size_bytes: 190_098_681,
  state: "missing",
};
const PHONE_CATALOG = [
  {
    id: "small.en-q5_1",
    label: "Recommended",
    size: "190 MB",
    description: "Better accuracy; uses more storage and memory. English only.",
  },
  {
    id: "base.en-q5_1",
    label: "Less accurate",
    size: "60 MB",
    description:
      "Smaller download; expect more errors on fast or overlapping speech. English only.",
  },
];
const PHONE_HOST = {
  name: "ios",
  can_spawn_processes: false,
  loopback_is_trusted: false,
  media_tools: "in_process",
  transcription: "whisper_cpp",
  folder_picker: false,
};

/** The desktop mock, with its status answered as an iPhone host with the two whisper variants. */
async function mockIphone(page: Page): Promise<void> {
  await mockBootstrap(page, { rows: [PHONE_WHISPER] });
  await page.route(
    (url) => url.pathname === "/api/bootstrap/status",
    async (route) => {
      const variant =
        new URL(route.request().url()).searchParams.get("whisper_model") ??
        "small.en-q5_1";
      const chosen = PHONE_CATALOG.find((c) => c.id === variant)!;
      await route.fulfill({
        json: {
          ready: false,
          cdn_base: false,
          whisper_model: variant,
          whisper_models: PHONE_CATALOG,
          host: PHONE_HOST,
          tools: {
            ffmpeg: { state: "installed", source: "bundled", hint: null },
          },
          models: [
            {
              ...PHONE_WHISPER,
              model: variant,
              size: chosen.size,
              size_bytes: variant === "base.en-q5_1" ? 59_721_011 : 190_098_681,
            },
          ],
        },
      });
    },
  );
}

/** `inner` lies inside `outer` on the inline axis, to within a pixel. */
async function expectInside(inner: Locator, outer: Locator): Promise<void> {
  const [i, o] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  expect(i).not.toBeNull();
  expect(o).not.toBeNull();
  expect(i!.x).toBeGreaterThanOrEqual(o!.x - 1);
  expect(i!.x + i!.width).toBeLessThanOrEqual(o!.x + o!.width + 1);
}

/** No descendant text is clipped by, or spills out of, `button`. */
async function expectNoClippedText(button: Locator): Promise<void> {
  const clipped = await button.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      scroll: el.scrollWidth - el.clientWidth,
      spill: [...el.querySelectorAll("span")].filter((s) => {
        const r = s.getBoundingClientRect();
        return r.left < box.left - 1 || r.right > box.right + 1;
      }).length,
    };
  });
  expect(clipped.scroll).toBeLessThanOrEqual(0);
  expect(clipped.spill).toBe(0);
}

const SIZES = [
  { name: "390x844", width: 390, height: 844, fontPx: null },
  { name: "320x568-200pct", width: 320, height: 568, fontPx: 32 },
] as const;

for (const size of SIZES) {
  test.describe(`models iphone ${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });

    test("Models sheet offers Recommended and Less accurate, fitted, with the description note", async ({
      page,
    }) => {
      await prepare(page, "light", false);
      await mockIphone(page);
      await openHome(page, { dismissSetup: false });
      if (size.fontPx) await setRootFontSize(page, size.fontPx);
      const setup = page.getByRole("region", { name: "Get ShareCut ready" });
      await setup.getByRole("button", { name: "Choose…" }).click();
      const dialog = page.getByRole("dialog", { name: "Models" });
      await expect(dialog).toBeVisible();
      const group = dialog.getByRole("group", { name: "Size" });
      const recommended = group.getByRole("button", {
        name: "Recommended 190 MB",
      });
      const less = group.getByRole("button", { name: "Less accurate 60 MB" });
      await expect(recommended).toBeVisible();
      await expect(less).toBeVisible();
      await expect(recommended).toHaveAttribute("aria-pressed", "true");
      await expect(less).toHaveAttribute("aria-pressed", "false");
      await expect(group.getByRole("button")).toHaveCount(2);

      const note = dialog.locator(".sys-size-note");
      await expect(note).toBeVisible();
      await expect(note).toContainText("Better accuracy");
      await expect(group).toHaveAccessibleDescription(
        PHONE_CATALOG[0].description,
      );

      for (const button of [recommended, less]) {
        await expectInside(button, group);
        await expectInside(button, dialog);
        await expectNoClippedText(button);
      }
      await expectInside(note, dialog);
      await expectNoHorizontalScroll(page);
      await expectTouchTargets(dialog);
      await shot(page, size.name, "light", "iphone-models-recommended");

      await less.click();
      await expect(less).toHaveAttribute("aria-pressed", "true");
      await expect(recommended).toHaveAttribute("aria-pressed", "false");
      await expect(note).toContainText("Smaller download");
      await expect(note).not.toContainText("Better accuracy");
      await expect(group).toHaveAccessibleDescription(
        PHONE_CATALOG[1].description,
      );
      await expectInside(less, group);
      await expectNoClippedText(less);
      await expectNoHorizontalScroll(page);
      await shot(page, size.name, "light", "iphone-models-less-accurate");
    });

    test("Home Setup card speaks of this iPhone, not a computer", async ({
      page,
    }) => {
      await prepare(page, "light", false);
      await mockIphone(page);
      await openHome(page, { dismissSetup: false });
      if (size.fontPx) await setRootFontSize(page, size.fontPx);
      const setup = page.getByRole("region", { name: "Get ShareCut ready" });
      await expect(setup).toContainText(
        "Transcription runs on this iPhone. One download, about 190 MB.",
      );
      await expect(setup).not.toContainText(/computer/i);
      await expectNoHorizontalScroll(page);
      await shot(page, size.name, "light", "iphone-setup-card");
    });
  });
}
