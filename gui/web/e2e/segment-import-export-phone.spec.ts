import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectSurfaceAxeClean } from "./axe";
import { expectFeedback } from "./feedback";
import { openHome } from "./home";
import {
  expectNoHorizontalScroll,
  expectTouchTargets,
  mockBootstrap,
  prepare,
  shot,
} from "./modelsMock";
import { setRootFontSize } from "./rootFontSize";
import { withAppearance } from "./theme";

const CELLS = [
  { name: "390x844", width: 390, height: 844, fontPx: null },
  { name: "320x740", width: 320, height: 740, fontPx: null },
  { name: "320x568-200pct", width: 320, height: 568, fontPx: 32 },
] as const;

type Row = Record<string, unknown>;

const COLD_OPEN: Row = {
  id: "cold-open-1a2b3c4d",
  name: "Cold open",
  kind: "intro",
  version: 1,
  versions: [1],
  clips: [{ audio: "intro.flac", offset_sec: 0, duration_sec: 12.4 }],
};

const AUDIO = Buffer.from("fLaC-test-audio");

function storedZip(entries: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const label = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(label.length, 26);
    parts.push(local, label, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(label.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, label);
    offset += 30 + label.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

/** A real `.sharecutseg`: segment.json, one clip and the manifest that hashes them. */
function segmentFile(name: string, kind = "intro", seconds = 22): Buffer {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const json = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      id: `${slug}-${sha(name).slice(0, 8)}`,
      name,
      kind,
      version: 1,
      role: "intro",
      fader_db: 0,
      clips: [{ audio: "clip-01.flac", offset_sec: 0, duration_sec: seconds }],
      media: { "clip-01.flac": { sha256: sha(AUDIO), bytes: AUDIO.length } },
    }),
  );
  const manifest = Buffer.from(
    `${sha(json)}  segment.json\n${sha(AUDIO)}  clip-01.flac\n`,
  );
  return storedZip({
    "segment.json": json,
    "clip-01.flac": AUDIO,
    "MANIFEST.sha256": manifest,
  });
}

function segmentJsonOf(file: Buffer): Record<string, unknown> | null {
  const at = file.indexOf("segment.json");
  if (file.subarray(0, 2).toString() !== "PK" || at < 0) return null;
  const size = file.readUInt32LE(at - 30 + 18);
  return JSON.parse(file.subarray(at + 12, at + 12 + size).toString());
}

function silence(): Buffer {
  const rate = 8000;
  const samples = Math.round(rate * 0.3);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 128)]);
}

const TOKEN = "f".repeat(32);

type Mock = {
  rows: Row[];
  uploads: { bytes: Buffer; type: string | undefined }[];
  commits: string[];
  cancels: string[];
  audio: string[];
  exports: string[];
};

async function mockLibrary(page: Page, rows: Row[]): Promise<Mock> {
  const mock: Mock = {
    rows: [...rows],
    uploads: [],
    commits: [],
    cancels: [],
    audio: [],
    exports: [],
  };
  await page.route(
    (url) => url.pathname.startsWith("/api/segments"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (url.pathname === "/api/segments" && method === "GET") {
        await route.fulfill({ json: mock.rows });
        return;
      }
      if (url.pathname === "/api/segments/import/preview") {
        const bytes = request.postDataBuffer() ?? Buffer.alloc(0);
        mock.uploads.push({
          bytes,
          type: request.headers()["content-type"],
        });
        const found = segmentJsonOf(bytes);
        if (!found) {
          await route.fulfill({
            status: 422,
            headers: { "X-Sharecut-Error-Code": "segment_bundle_invalid" },
            json: { detail: "This file is not a segment bundle." },
          });
          return;
        }
        const existing = mock.rows.find((row) => row.name === found.name);
        await route.fulfill({
          json: {
            token: TOKEN,
            name: found.name,
            kind: found.kind,
            duration_sec: 22,
            clip_count: 1,
            outcome: existing ? "unchanged" : "added",
            version: 1,
            existing_id: existing ? existing.id : null,
          },
        });
        return;
      }
      if (url.pathname === "/api/segments/import" && method === "POST") {
        mock.commits.push(request.postData() ?? "");
        const added = {
          id: "warm-bed-5c1d0000",
          name: "Warm bed",
          kind: "intro",
          version: 1,
          versions: [1],
          clips: [{ audio: "clip-01.flac", offset_sec: 0, duration_sec: 22 }],
        };
        mock.rows.push(added);
        await route.fulfill({
          json: { status: "added", id: added.id, version: 1 },
        });
        return;
      }
      const staged = url.pathname.match(
        /^\/api\/segments\/import\/([0-9a-f]+)(\/audio)?$/,
      );
      if (staged && method === "GET") {
        mock.audio.push(`${staged[1]}?${url.searchParams.toString()}`);
        await route.fulfill({ contentType: "audio/wav", body: silence() });
        return;
      }
      if (staged && method === "DELETE") {
        mock.cancels.push(staged[1]);
        await route.fulfill({ json: { cancelled: staged[1] } });
        return;
      }
      const exported = url.pathname.match(/^\/api\/segments\/([^/]+)\/export$/);
      if (exported && method === "GET") {
        mock.exports.push(exported[1]);
        await route.fulfill({
          contentType: "application/zip",
          headers: {
            "content-disposition":
              'attachment; filename="cold-open.sharecutseg"',
          },
          body: segmentFile("Cold open"),
        });
        return;
      }
      await route.fallback();
    },
  );
  return mock;
}

async function expectInsideViewport(scope: Locator): Promise<void> {
  const width = await scope.page().evaluate(() => window.innerWidth);
  for (const control of await scope.getByRole("button").all()) {
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  }
}

async function chooseFile(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: "application/zip", buffer });
}

/** The sheet slides and resizes in; wait until two samples agree before measuring it. */
async function settled(scope: Locator): Promise<void> {
  let last = "";
  await expect
    .poll(async () => {
      const box = JSON.stringify(await scope.boundingBox());
      const same = box === last;
      last = box;
      return same;
    })
    .toBe(true);
}

const importSheet = (page: Page) =>
  page.getByRole("dialog", { name: "Import a segment" });

for (const { cell, theme, reducedMotion } of withAppearance(CELLS)) {
  test.describe(`segment import and export phone ${cell.name}`, () => {
    test.use({
      viewport: { width: cell.width, height: cell.height },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
    });

    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
      });
      await prepare(page, theme, true);
      await mockBootstrap(page);
    });

    async function home(page: Page, rows: Row[] = [COLD_OPEN]) {
      const mock = await mockLibrary(page, rows);
      await openHome(page);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      const section = page.getByRole("region", { name: "Segment library" });
      await expect(section).toBeVisible();
      return { mock, section };
    }

    test("a chosen file previews with its name, length and outcome, plays, adds and refreshes the list", async ({
      page,
    }) => {
      const { mock, section } = await home(page);
      await expectTouchTargets(section);
      const file = segmentFile("Warm bed");

      await chooseFile(page, "warm-bed.sharecutseg", file);

      const sheet = importSheet(page);
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("Warm bed");
      await expect(sheet).toContainText("Intro");
      await expect(sheet).toContainText("0:22");
      await expect(sheet).toContainText("Adds Warm bed");
      expect(mock.uploads).toHaveLength(1);
      expect(mock.uploads[0].type).toBe("application/octet-stream");
      expect(mock.uploads[0].bytes.equals(file)).toBe(true);
      await expect(
        sheet.getByRole("button", { name: "Add to library" }),
      ).toBeVisible();
      await expectTouchTargets(sheet);
      await expectInsideViewport(sheet);
      await expectNoHorizontalScroll(page);
      await settled(sheet);
      await expectSurfaceAxeClean(page, '[role="dialog"]');
      await shot(page, cell.name, theme, "segment-import-preview");

      await sheet.getByRole("button", { name: "Play Warm bed" }).click();
      await expect.poll(() => mock.audio.length).toBeGreaterThan(0);
      expect(mock.audio[0]).toBe(`${TOKEN}?clip=0`);

      await sheet.getByRole("button", { name: "Add to library" }).click();
      await expect(sheet).toHaveCount(0);
      expect(mock.commits).toEqual([JSON.stringify({ token: TOKEN })]);
      await expectFeedback(page, "Added Warm bed to your library");
      const list = section.getByRole("list", { name: "Segment library" });
      await expect(list.getByRole("listitem")).toHaveCount(2);
      await expect(
        list.getByRole("listitem").filter({ hasText: "Warm bed" }),
      ).toHaveAttribute("data-new", "true");
      await expect(
        page.getByRole("button", { name: "Import", exact: true }),
      ).toBeFocused();
      await expectTouchTargets(section);
      await expectNoHorizontalScroll(page);
    });

    test("a file already in the library says so and adds nothing", async ({
      page,
    }) => {
      const { mock, section } = await home(page);
      await chooseFile(page, "cold-open.sharecutseg", segmentFile("Cold open"));
      const sheet = importSheet(page);
      await expect(sheet).toContainText("Already in your library");
      await expect(
        sheet.getByRole("button", { name: "Add to library" }),
      ).toHaveCount(0);
      await expectTouchTargets(sheet);
      await sheet.getByRole("button", { name: "Show in library" }).click();
      await expect(sheet).toHaveCount(0);
      await expectFeedback(page, "Cold open is already in your library");
      expect(mock.commits).toEqual([]);
      expect(mock.cancels).toEqual([TOKEN]);
      await expect(
        section
          .getByRole("list", { name: "Segment library" })
          .getByRole("listitem"),
      ).toHaveCount(1);
    });

    test("a file the service refuses shows its message and adds nothing", async ({
      page,
    }) => {
      const { mock, section } = await home(page);
      await chooseFile(page, "notes.sharecutseg", Buffer.from("not a zip"));
      const sheet = importSheet(page);
      await expect(sheet.getByRole("alert")).toHaveText(
        "This file is not a segment bundle.",
      );
      await expect(sheet).toContainText("notes.sharecutseg");
      await expect(
        sheet.getByRole("button", { name: "Add to library" }),
      ).toHaveCount(0);
      await expectTouchTargets(sheet);
      await expectInsideViewport(sheet);
      await expectNoHorizontalScroll(page);
      await settled(sheet);
      await expectSurfaceAxeClean(page, '[role="dialog"]');
      await shot(page, cell.name, theme, "segment-import-refused");
      await sheet
        .locator(".sys-segment-actions")
        .getByRole("button", { name: "Close" })
        .click();
      await expect(sheet).toHaveCount(0);
      expect(mock.commits).toEqual([]);
      await expect(
        section
          .getByRole("list", { name: "Segment library" })
          .getByRole("listitem"),
      ).toHaveCount(1);
    });

    test("Cancel removes the waiting file", async ({ page }) => {
      const { mock } = await home(page);
      await chooseFile(page, "warm-bed.sharecutseg", segmentFile("Warm bed"));
      const sheet = importSheet(page);
      await sheet.getByRole("button", { name: "Cancel" }).click();
      await expect(sheet).toHaveCount(0);
      expect(mock.cancels).toEqual([TOKEN]);
      expect(mock.commits).toEqual([]);
    });

    test("a dropped segment file opens the preview and another kind of file is refused", async ({
      page,
    }) => {
      const { mock, section } = await home(page);
      const body = section.locator(".segment-library-body");
      const drop = (name: string, bytes: number[]) =>
        body.evaluate(
          (element, { name, bytes }) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([new Uint8Array(bytes)], name));
            for (const type of ["dragover", "drop"]) {
              element.dispatchEvent(
                new DragEvent(type, {
                  dataTransfer: transfer,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            }
          },
          { name, bytes },
        );

      await drop("take.wav", [1, 2, 3]);
      await expect(section.getByRole("alert")).toContainText(
        "That isn't a segment or kit file (.sharecutseg, .sharecutkit).",
      );
      expect(mock.uploads).toHaveLength(0);

      await drop("warm-bed.sharecutseg", [...segmentFile("Warm bed")]);
      await expect(importSheet(page)).toContainText("Adds Warm bed");
      expect(mock.uploads).toHaveLength(1);
    });

    test("Export as file downloads the segment file", async ({ page }) => {
      const { mock, section } = await home(page);
      await section
        .getByRole("button", { name: "More actions for Cold open" })
        .click();
      const menu = page.getByRole("menuitem", { name: "Export as file" });
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(43);
      const downloading = page.waitForEvent("download");
      await menu.click();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe("cold-open.sharecutseg");
      expect(mock.exports).toEqual([COLD_OPEN.id]);
      await expectFeedback(page, "Saved cold-open.sharecutseg");
    });
  });
}

test.describe("segment export through the share sheet", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("a phone that can share files shares the segment file instead of downloading it", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const shared: { name: string; type: string; size: number }[] = [];
      Object.assign(window, { __shared: shared });
      Object.assign(navigator, {
        canShare: (data: { files?: File[] }) => (data.files?.length ?? 0) > 0,
        share: async (data: { files: File[] }) => {
          for (const file of data.files)
            shared.push({ name: file.name, type: file.type, size: file.size });
        },
      });
    });
    await prepare(page, "light", true);
    await mockBootstrap(page);
    const mock = await mockLibrary(page, [COLD_OPEN]);
    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });
    await openHome(page);
    const section = page.getByRole("region", { name: "Segment library" });
    await section
      .getByRole("button", { name: "More actions for Cold open" })
      .click();
    await page.getByRole("menuitem", { name: "Export as file" }).click();

    await expectFeedback(page, "Shared Cold open");
    const shared = await page.evaluate(
      () => (window as unknown as { __shared: unknown[] }).__shared,
    );
    expect(shared).toEqual([
      {
        name: "cold-open.sharecutseg",
        type: "application/zip",
        size: segmentFile("Cold open").length,
      },
    ]);
    expect(mock.exports).toEqual([COLD_OPEN.id]);
    expect(downloads).toBe(0);
  });
});
