import { expect, test } from "@playwright/test";
import { parseWavHeader } from "../src/audio/wavHeader";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath, e2eUrl } from "./env";
import { openPanel, openProject } from "./stageNav";

/**
 * RMS of the reference track stem in `[startSec, endSec)`, rebuilt fresh
 * (`rerender=true`) so an ignore/restore is reflected immediately.
 */
async function stemRms(
  request: import("@playwright/test").APIRequestContext,
  startSec: number,
  endSec: number,
): Promise<number> {
  const url =
    `${e2eUrl()}/api/audio?path=${encodeURIComponent(e2eProjectPath)}` +
    "&kind=stem&track_id=reference&rerender=true";
  const res = await request.get(url);
  expect(res.ok()).toBe(true);
  const buffer = await res.body();
  const header = parseWavHeader(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
  const bytesPerSample = header.bitsPerSample / 8;
  const startFrame = Math.floor(startSec * header.sampleRate);
  const endFrame = Math.ceil(endSec * header.sampleRate);
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset + header.dataOffset,
    header.dataSize,
  );
  let sumSquares = 0;
  let count = 0;
  for (let frame = startFrame; frame < endFrame; frame++) {
    const offset = frame * header.blockAlign;
    if (offset + bytesPerSample > header.dataSize) {
      break;
    }
    const sample =
      header.bitsPerSample === 16
        ? view.getInt16(offset, true) / 32768
        : view.getFloat32(offset, true);
    sumSquares += sample * sample;
    count += 1;
  }
  return count > 0 ? Math.sqrt(sumSquares / count) : 0;
}

test.describe("Transcript ignore mutes the stem; restore brings it back (#633)", () => {
  test("ignore mutes the word span at render, restore un-mutes it", async ({
    page,
    request,
  }) => {
    const baseline = await stemRms(request, 2.56, 2.75);
    expect(baseline).toBeGreaterThan(0.03);

    await openProject(page, e2eProjectPath);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await openPanel(page, "transcript");

    const list = page.locator(".sys-script-body");
    const uncle = list.locator('[data-word-key="reference::1"]');
    const was = list.locator('[data-word-key="reference::2"]');

    let restored = false;
    try {
      await uncle.click();
      await was.click({ modifiers: ["Shift"] });

      const commands: string[] = [];
      page.on("request", (req) => {
        if (
          req.url().includes("/api/document/command") &&
          req.method() === "POST"
        ) {
          const type = (req.postDataJSON() as { type?: string } | null)?.type;
          if (type) commands.push(type);
        }
      });

      await page.getByRole("button", { name: /^Ignore/ }).click();
      await expect(async () => {
        expect(commands).toContain("SetTranscriptWordsIgnored");
      }).toPass();
      await expect(uncle).toHaveAttribute("data-state", "muted");
      await expect(was).toHaveAttribute("data-state", "muted");
      restored = false;

      const mutedRms = await stemRms(request, 2.56, 2.75);
      expect(mutedRms).toBeLessThan(baseline * 0.01);

      await expectPageAxeClean(page, ".sys-script");

      await page.getByRole("button", { name: /^Restore/ }).click();
      restored = true;

      await expect(uncle).not.toHaveAttribute("data-state", "muted");
      await expect(was).not.toHaveAttribute("data-state", "muted");

      const restoredRms = await stemRms(request, 2.56, 2.75);
      expect(restoredRms).toBeCloseTo(baseline, 4);
    } finally {
      if (!restored) {
        await page.request.post(
          `/api/document/command?path=${encodeURIComponent(e2eProjectPath)}`,
          {
            data: {
              type: "SetTranscriptWordsIgnored",
              payload: {
                track_id: "reference",
                start_word_index: 1,
                end_word_index: 2,
                ignored: false,
              },
              client_id: "e2e-ignore-cleanup",
              role: "viewer",
            },
          },
        );
      }
    }
  });
});
