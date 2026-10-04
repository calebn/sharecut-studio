import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { createRelocatedE2eProject } from "./liveProject";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { setTheme } from "./theme";
import { openTranscriptPanel } from "./transcriptEdit";

type Seed = {
  timeline: { tracks: { id: string }[] };
  mix: {
    automation_envelopes: {
      track_id: string;
      parameter: string;
      points: { id: string; time: number; value: number }[];
    }[];
  };
};
function seed(prefix: string) {
  const fixture = createRelocatedE2eProject(prefix);
  const project = JSON.parse(
    fs.readFileSync(fixture.projectPath, "utf8"),
  ) as Seed;
  project.mix.automation_envelopes = [
    {
      track_id: project.timeline.tracks[0].id,
      parameter: "volume",
      points: [
        { id: "policy-first", time: 2, value: 0.8 },
        { id: "policy-second", time: 10, value: 1.2 },
      ],
    },
  ];
  fs.writeFileSync(
    fixture.projectPath,
    `${JSON.stringify(project, null, 2)}\n`,
  );
  return fixture;
}
async function nativeEvidence(page: Page) {
  await page.evaluate(() => {
    const bag = {
      events: [] as {
        type: string;
        trusted: boolean;
        ctrl: boolean;
        key?: string;
      }[],
    };
    Object.assign(window, { __navigationAudit: bag });
    for (const type of ["wheel", "keydown", "pointerdown"])
      document.addEventListener(
        type,
        (event) => {
          bag.events.push({
            type: event.type,
            trusted: event.isTrusted,
            ctrl: (event as WheelEvent).ctrlKey ?? false,
            key: (event as KeyboardEvent).key,
          });
        },
        true,
      );
  });
}
async function events(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __navigationAudit: { events: unknown[] } })
        .__navigationAudit.events,
  );
}
async function width(page: Page) {
  return page
    .locator('[data-testid="timeline-clip"]')
    .first()
    .evaluate((el) => Number.parseFloat((el as HTMLElement).style.width));
}
async function wheel(page: Page, delta: number, modified = true) {
  const ruler = page.getByRole("slider", { name: "Timeline position" });
  const rect = await ruler.boundingBox();
  if (!rect) throw new Error("Ruler unavailable");
  await page.mouse.move(500, rect.y + rect.height / 2);
  if (modified) await page.keyboard.down("Control");
  await page.mouse.wheel(0, delta);
  if (modified) await page.keyboard.up("Control");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
test("F03/F13 native ruler clock and modifier wheel anchor reversal bounds and typing refusal", async ({
  page,
}, info) => {
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      await setTheme(page, "light");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await nativeEvidence(page);
      const saved = fs.readFileSync(projectPath, "utf8");
      const commands: string[] = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && r.url().includes("/api/document/command"))
          commands.push(r.postData() ?? "");
      });
      const ruler = page.getByRole("slider", { name: "Timeline position" });
      await ruler.focus();
      await page.keyboard.press("Home");
      await expect(ruler).toHaveAttribute("aria-valuenow", "0");
      await page.keyboard.press("End");
      await expect(ruler).toHaveAttribute("aria-valuenow", "60");
      await page.keyboard.press("Home");
      const z = (await width(page)) / 60;
      const rect = (await ruler.boundingBox())!;
      await ruler.click({ position: { x: 3 * z, y: rect.height / 2 } });
      await expect
        .poll(async () => Number(await ruler.getAttribute("aria-valuenow")))
        .toBeCloseTo(3, 3);
      const anchor = async () =>
        ruler.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const x = 500;
          const clip = document.querySelector(
            '[data-testid="timeline-clip"]',
          ) as HTMLElement;
          const scale = Number.parseFloat(clip.style.width) / 60;
          return { clientX: x, sec: (x - r.x) / scale, scale };
        });
      const origin = await anchor();
      const w = await width(page);
      await wheel(page, -120);
      await expect.poll(() => width(page)).toBeCloseTo(w * 1.25, 1);
      const enlarged = await anchor();
      expect(enlarged.sec).toBeCloseTo(origin.sec, 1);
      await wheel(page, 120);
      await expect.poll(() => width(page)).toBeCloseTo(w, 1);
      const reversed = await anchor();
      expect(reversed.sec).toBeCloseTo(origin.sec, 1);
      await openTranscriptPanel(page);
      await page
        .getByRole("button", { name: "Find and replace", exact: true })
        .click();
      const input = page
        .getByRole("region", { name: "Find and replace transcript" })
        .getByRole("textbox", { name: "Find", exact: true });
      await input.focus();
      await expect(input).toBeFocused();
      const typingWidth = await width(page);
      await wheel(page, -120);
      expect(await width(page)).toBe(typingWidth);
      await ruler.focus();
      const plain = await width(page);
      await wheel(page, 120, false);
      expect(await width(page)).toBe(plain);
      const bounds: { phase: string; width: number }[] = [];
      for (let i = 0; i < 40; i++) {
        await wheel(page, -120);
        bounds.push({ phase: "up", width: await width(page) });
      }
      await expect.poll(() => width(page)).toBe(2880000);
      const ceiling = await width(page);
      await wheel(page, -120);
      expect(await width(page)).toBe(ceiling);
      for (let i = 0; i < 75; i++) {
        await wheel(page, 120);
        bounds.push({ phase: "down", width: await width(page) });
      }
      await expect.poll(() => width(page)).toBe(4);
      const floor = await width(page);
      await wheel(page, 120);
      expect(await width(page)).toBe(floor);
      expect(commands).toEqual([]);
      expect(fs.readFileSync(projectPath, "utf8")).toBe(saved);
      const inputEvents = await events(page);
      expect(inputEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "wheel", trusted: true, ctrl: true }),
          expect.objectContaining({
            type: "keydown",
            trusted: true,
            key: "Home",
          }),
        ]),
      );
      fs.writeFileSync(
        info.outputPath("navigation-evidence.json"),
        `${JSON.stringify({ viewport: { width: 1440, height: 900 }, theme: "light", motion: "reduce", permission: "host", nativeInput: true, syntheticEvents: false, physicalDevice: false, origin, enlarged, reversed, typingWidth, bounds, commands, inputEvents, floorMeaning: "rendered clip4px minimum; does not expose exact underlying0.05px/s" }, null, 2)}\n`,
      );
      await page.screenshot({ path: info.outputPath("navigation-final.png") });
    },
    undefined,
    seed,
  );
});
test("F09 host numeric inspector and view-only guest select without envelope mutation", async ({
  page,
  browser,
}, info) => {
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      await setTheme(page, "dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      const owner = page
        .locator('circle[aria-label^="Envelope point 1 at"]')
        .first();
      await owner.click();
      await page
        .getByRole("button", { name: "Edit point", exact: true })
        .click();
      await expect(page.getByLabel("Time (seconds on timeline)")).toHaveValue(
        "2",
      );
      await expect(page.getByLabel("Level (×)")).toHaveValue("0.8");
      await expect(
        page.getByRole("button", { name: "Save point", exact: true }),
      ).toBeEnabled();
      const token = await createReviewShare(page, projectPath, "viewer");
      const savedAfterShare = fs.readFileSync(projectPath, "utf8");
      const context = await browser.newContext({
        baseURL: new URL(page.url()).origin,
        viewport: { width: 1440, height: 900 },
        reducedMotion: "reduce",
      });
      try {
        const guest = await context.newPage();
        await openGuestShare(guest, token);
        await setTheme(guest, "dark");
        await expect(guest.locator("html")).toHaveAttribute(
          "data-theme",
          "dark",
        );
        await nativeEvidence(guest);
        const requests: string[] = [];
        guest.on("request", (r) => {
          if (r.method() === "POST" && r.url().includes("/document/command"))
            requests.push(r.postData() ?? "");
        });
        const point = guest
          .locator('circle[aria-label^="Envelope point 1 at"]')
          .first();
        await expect(point).toBeVisible();
        await point.click();
        await expect(point).toHaveAttribute("aria-pressed", "true");
        await expect(
          guest.getByLabel("Time (seconds on timeline)"),
        ).toHaveCount(0);
        await expect(guest.getByLabel("Level (×)")).toHaveCount(0);
        await expect(guest.locator(".modifier-inspector")).toContainText(
          "Envelope",
        );
        const geometry = () =>
          point.evaluate((el) => ({
            cx: el.getAttribute("cx"),
            cy: el.getAttribute("cy"),
          }));
        const origin = await geometry();
        const box = (await point.boundingBox())!;
        await guest.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await guest.mouse.down();
        await guest.mouse.move(
          box.x + box.width / 2 + 28,
          box.y + box.height / 2 - 8,
          { steps: 4 },
        );
        await guest.mouse.up();
        expect(await geometry()).toEqual(origin);
        expect(requests).toEqual([]);
        await point.focus();
        await guest.keyboard.press("Enter");
        await expect(point).toHaveAttribute("aria-pressed", "true");
        expect(fs.readFileSync(projectPath, "utf8")).toBe(savedAfterShare);
        fs.writeFileSync(
          info.outputPath("envelope-view-policy.json"),
          `${JSON.stringify({ role: "viewer", theme: "dark", motion: "reduce", nativeMouseKeyboard: true, physicalDevice: false, origin, after: await geometry(), requests, inputEvents: await events(guest), hostFields: { time: 2, value: 0.8 } }, null, 2)}\n`,
        );
        await guest.screenshot({
          path: info.outputPath("envelope-view-inspector.png"),
        });
      } finally {
        await context.close();
      }
    },
    undefined,
    seed,
  );
});
