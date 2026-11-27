import { expect, type Locator, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { type Finger, newFinger, type Point } from "./finger";
import { layer } from "./lifecycleAudit";
import { openPhoneTimeline } from "./phoneTimeline";
import { ROTATION_SIZES } from "./rotationSizes";
import { settledBox } from "./settledBox";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { openProject } from "./stageNav";
import {
  buildFixture,
  centerOf,
  lane,
  projectJson,
  setZoom,
  TRACK,
  watchCommands,
} from "./touchTimeline";

test.use({ hasTouch: true });
test.describe.configure({ timeout: 180_000 });

const SIZES = ROTATION_SIZES;
type Size = (typeof SIZES)[number];

const DRAGGING =
  ".fade-dragging, .trim-dragging, [data-dragging], .precision-layer";
const STUCK = `[data-hit-armed], ${DRAGGING}`;

type Rig = {
  page: Page;
  finger: Finger;
  writes: () => unknown[];
  projectPath: string;
};

type Kind = {
  name: string;
  command: string;
  dragging: string;
  zoom?: number;
  open(page: Page, projectPath: string, size: Size): Promise<void>;
  ready(rig: Rig): Promise<void>;
  grab(rig: Rig): Promise<void>;
  slide(rig: Rig, stage: 1 | 2): Promise<void>;
  release(rig: Rig): Promise<void>;
  saved(rig: Rig): Promise<string>;
};

const stuck = (page: Page) => page.locator(STUCK).count();
const dragging = (page: Page) => page.locator(DRAGGING).count();

const centre = async (locator: Locator): Promise<Point> => {
  await expect(locator).toBeVisible();
  const box = await settledBox(locator);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );

const tapFirstClip = async (page: Page, finger: Finger) => {
  const at = await centre(page.locator(".clip-hit").first());
  await finger.down(at);
  await finger.up();
  await expect(page.locator(".fade-corner.in").first()).toBeVisible();
  await frames(page);
};

type EnvelopeJson = {
  envelopes: { track_id: string; points: { id: string; time: number }[] }[];
};

const envelopeFixture = async (page: Page, projectPath: string) =>
  postDocumentCommand(
    page,
    "e2e-rotation",
    "SetEnvelope",
    {
      track_id: TRACK,
      expected_points: [],
      points: [
        { id: "env-a", time: 20, value: 1 },
        { id: "env-b", time: 40, value: 0.8 },
      ],
    },
    projectPath,
  );

let anchor: Point = { x: 0, y: 0 };

const envelope: Kind = {
  name: "envelope point",
  command: "SetEnvelope",
  dragging: "[data-dragging]",
  async open(page, projectPath) {
    await envelopeFixture(page, projectPath);
    await openHostShare(page, projectPath);
    await openPhoneTimeline(page);
    await layer(page, "Volume envelope", true);
  },
  async ready({ page, finger }) {
    await tapFirstClip(page, finger);
  },
  async grab({ page, finger }) {
    anchor = await centre(page.locator(".sys-env-point").first());
    await finger.down(anchor);
    await expect(page.locator("[data-hit-armed]")).toHaveCount(1);
  },
  async slide({ finger }, stage) {
    await finger.slide({ x: anchor.x + 40 * stage, y: anchor.y }, 4, 16);
  },
  async release({ finger }) {
    await finger.up();
  },
  async saved({ page, projectPath }) {
    const json = (await projectJson(page, projectPath)) as unknown as
      | EnvelopeJson
      | undefined;
    return JSON.stringify(json?.envelopes ?? []);
  },
};

const fade: Kind = {
  name: "fade",
  command: "SetClipFade",
  dragging: ".fade-dragging",
  async open(page, projectPath) {
    await openHostShare(page, projectPath);
    await openPhoneTimeline(page);
  },
  async ready({ page, finger }) {
    await tapFirstClip(page, finger);
  },
  async grab({ page, finger }) {
    const corner = await centre(page.locator(".fade-corner.in").first());
    await finger.down(corner);
    const chip = page
      .locator(".edit-target-chooser")
      .getByRole("menuitem", { name: /Fade in/ });
    anchor = await centre(chip);
    await finger.slide(anchor, 4, 16);
    await frames(page);
    await finger.slide({ x: anchor.x + 12, y: anchor.y }, 3, 16);
  },
  async slide({ finger }, stage) {
    await finger.slide({ x: anchor.x + 40 * stage, y: anchor.y }, 4, 16);
  },
  async release({ finger }) {
    await finger.up();
  },
  async saved({ page, projectPath }) {
    const rows = (await projectJson(page, projectPath)).clips.tracks[TRACK];
    return JSON.stringify(rows.map((c) => [c.id, c.fade_in_ms]));
  },
};

const lastClipId = async (page: Page, projectPath: string) => {
  const rows = (await projectJson(page, projectPath)).clips.tracks[TRACK];
  const clip = rows.find((c) => c.timeline_start === 50);
  if (!clip) throw new Error("fixture clip at 50 s missing");
  return clip.id;
};

const trimSaved = async ({ page, projectPath }: Rig) => {
  const rows = (await projectJson(page, projectPath)).clips.tracks[TRACK];
  return JSON.stringify(rows.map((c) => [c.id, c.source_end]));
};

const trimOpen = async (page: Page, projectPath: string) => {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, "e2e-rotation");
  await openPhoneTimeline(page);
};

const trimHandle = async (rig: Rig) => {
  const id = await lastClipId(rig.page, rig.projectPath);
  return centerOf(rig.page, `${lane} [data-clip-id="${id}"] .trim-handle.out`);
};

const selectTrimClip = async (rig: Rig) => {
  const id = await lastClipId(rig.page, rig.projectPath);
  const body = await centerOf(rig.page, `${lane} [data-clip-id="${id}"]`);
  await rig.finger.down(body);
  await rig.finger.up();
  await expect(
    rig.page.locator(`${lane} [data-clip-id="${id}"] .trim-handle.out`),
  ).toBeVisible();
  await frames(rig.page);
};

const trimDirect: Kind = {
  name: "direct trim",
  command: "TrimClipEdge",
  dragging: ".trim-dragging",
  zoom: 24,
  open: trimOpen,
  async ready(rig) {
    await setZoom(rig.page, 24);
    await selectTrimClip(rig);
  },
  async grab(rig) {
    anchor = await trimHandle(rig);
    await rig.finger.down(anchor);
    await expect(
      rig.page.locator('.precision-layer[data-mode="direct"]'),
    ).toBeVisible();
  },
  async slide({ finger }, stage) {
    await finger.slide({ x: anchor.x - 30 * stage, y: anchor.y }, 4, 16);
  },
  async release({ finger }) {
    await finger.up();
  },
  saved: trimSaved,
};

const trimJog: Kind = {
  name: "jog pad trim",
  command: "TrimClipEdge",
  dragging: ".precision-jog-pad[data-dragging]",
  zoom: 3,
  open: trimOpen,
  async ready(rig) {
    await setZoom(rig.page, 3);
    await selectTrimClip(rig);
  },
  async grab(rig) {
    const handle = await trimHandle(rig);
    await rig.finger.down(handle);
    await expect(
      rig.page.locator('.precision-layer[data-mode="precision"]'),
    ).toBeVisible();
    await rig.finger.up();
    const pad = await settledBox(rig.page.locator(".precision-jog-pad"));
    anchor = { x: pad.x + pad.width / 2, y: pad.y + pad.height - 8 };
    await rig.finger.down(anchor);
  },
  async slide({ finger }, stage) {
    await finger.slide(
      { x: anchor.x - 20 * stage, y: anchor.y - 130 },
      stage === 1 ? 6 : 4,
      16,
    );
  },
  async release({ page, finger }) {
    await finger.up();
    const done = page.getByRole("button", { name: "Done" });
    if (await done.count()) await done.click();
  },
  saved: trimSaved,
};

const KINDS = [fade, trimDirect, trimJog, envelope];

const writes = (kind: Kind, commands: { type: string }[]) => () =>
  commands.filter((c) => c.type === kind.command);

async function withRig(
  kind: Kind,
  size: Size,
  page: Page,
  context: Parameters<typeof newFinger>[0],
  browserName: string,
  run: (rig: Rig) => Promise<void>,
) {
  await page.setViewportSize(size.portrait);
  await withShareableProject(async (projectPath) => {
    await kind.open(page, projectPath, size);
    const commands = watchCommands(page);
    const finger = await newFinger(context, page, browserName);
    const rig: Rig = {
      page,
      finger,
      projectPath,
      writes: writes(kind, commands),
    };
    await run(rig);
  });
}

const rotate = async (page: Page, size: Size, to: "portrait" | "landscape") => {
  await page.setViewportSize(size[to]);
  await expect
    .poll(() => page.evaluate(() => window.innerWidth))
    .toBe(size[to].width);
  await frames(page);
  if (size.swapsShell) {
    const phone = '[data-arrangement="phone"]';
    if (to === "landscape")
      await expect(
        page.locator(`[data-arrangement]:not(${phone})`),
      ).toBeVisible();
    else await expect(page.locator(phone)).toBeVisible();
  }
};

for (const kind of KINDS) {
  test(`${kind.name}: a drag left alone saves once`, async ({
    page,
    context,
    browserName,
  }) => {
    await withRig(kind, SIZES[1], page, context, browserName, async (rig) => {
      await kind.ready(rig);
      const before = await kind.saved(rig);
      await kind.grab(rig);
      await kind.slide(rig, 1);
      await expect(rig.page.locator(kind.dragging).first()).toBeVisible();
      await kind.slide(rig, 2);
      await kind.release(rig);
      await expect.poll(() => rig.writes().length).toBe(1);
      await expect.poll(() => kind.saved(rig)).not.toEqual(before);
      await expect.poll(() => stuck(rig.page)).toBe(0);
    });
  });

  test(`${kind.name}: a height-only resize does not end the drag`, async ({
    page,
    context,
    browserName,
  }) => {
    const size = SIZES[1];
    await withRig(kind, size, page, context, browserName, async (rig) => {
      await kind.ready(rig);
      await kind.grab(rig);
      await kind.slide(rig, 1);
      await expect(rig.page.locator(kind.dragging).first()).toBeVisible();
      await page.setViewportSize({
        width: size.portrait.width,
        height: size.portrait.height - 120,
      });
      await kind.slide(rig, 2);
      await kind.release(rig);
      await expect.poll(() => rig.writes().length).toBe(1);
      await page.setViewportSize(size.portrait);
    });
  });

  for (const size of SIZES) {
    test(`${kind.name}: rotating (${size.name}) mid-drag saves nothing, leaves nothing stuck, and a later drag saves once`, async ({
      page,
      context,
      browserName,
    }) => {
      await withRig(kind, size, page, context, browserName, async (rig) => {
        await kind.ready(rig);
        const before = await kind.saved(rig);
        await kind.grab(rig);
        await kind.slide(rig, 1);
        await expect(rig.page.locator(kind.dragging).first()).toBeVisible();

        await rotate(page, size, "landscape");
        await expect.poll(() => dragging(page)).toBe(0);
        await kind.slide(rig, 2);
        await kind.release(rig);
        await expect.poll(() => stuck(page)).toBe(0);
        const afterRotation = await kind.saved(rig);
        expect(afterRotation).toEqual(before);

        await rotate(page, size, "portrait");
        await kind.ready(rig);
        const sentBeforeSecond = rig.writes().length;
        await kind.grab(rig);
        await kind.slide(rig, 1);
        await kind.slide(rig, 2);
        await kind.release(rig);

        expect(sentBeforeSecond).toBe(0);
        await expect.poll(() => rig.writes().length).toBeGreaterThanOrEqual(1);
        await expect.poll(() => kind.saved(rig)).not.toEqual(afterRotation);
        expect(rig.writes()).toHaveLength(1);
        await expect.poll(() => stuck(page)).toBe(0);
      });
    });
  }
}

test("fade: a CDP screen-orientation override (width changes too) ends the drag", async ({
  page,
  context,
  browserName,
}) => {
  const size = SIZES[1];
  await withRig(fade, size, page, context, browserName, async (rig) => {
    await fade.ready(rig);
    const before = await fade.saved(rig);
    await fade.grab(rig);
    await fade.slide(rig, 1);
    await expect(rig.page.locator(fade.dragging).first()).toBeVisible();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      ...size.landscape,
      deviceScaleFactor: 1,
      mobile: true,
      screenOrientation: { type: "landscapePrimary", angle: 90 },
    });
    await expect.poll(() => dragging(page)).toBe(0);
    await fade.slide(rig, 2);
    await fade.release(rig);
    await expect.poll(() => stuck(page)).toBe(0);
    expect(await fade.saved(rig)).toEqual(before);
    expect(rig.writes()).toHaveLength(0);
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await page.setViewportSize(size.portrait);
  });
});

test("a rotation with no drag in progress writes nothing", async ({
  page,
  context,
  browserName,
}) => {
  const size = SIZES[1];
  await withRig(fade, size, page, context, browserName, async (rig) => {
    await fade.ready(rig);
    const all = watchCommands(page);
    await rotate(page, size, "landscape");
    await rotate(page, size, "portrait");
    await expect.poll(() => stuck(page)).toBe(0);
    await expect
      .poll(() => page.evaluate(() => window.innerWidth))
      .toBe(size.portrait.width);
    await frames(page);
    expect(all).toHaveLength(0);
  });
});
