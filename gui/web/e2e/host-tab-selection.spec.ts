import { expect, type Page, test } from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { withTwoBrowserPages } from "./twoBrowserPages";

/**
 * Operator decision (#1394): a host's own browser tabs do not share one
 * selection. A viewer echo from another tab never moves it, while an
 * agent-authored selection reaches every tab once, when the agent sets it:
 * a later unrelated agent command does not re-assert it.
 */

const DESKTOP = { width: 1440, height: 900 };
/** Long enough for a presence echo to cross the socket and be applied. */
const SYNC_SETTLE_MS = 2_500;

let agentClientSeq = 0;

async function agentCommand(
  page: Page,
  projectPath: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  agentClientSeq += 1;
  const response = await page.request.post(
    `/api/session/command?path=${encodeURIComponent(projectPath)}`,
    {
      data: {
        type,
        payload,
        client_id: "e2e-selection-agent",
        client_seq: agentClientSeq,
        role: "agent",
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

const agentSelectsClip = (
  page: Page,
  projectPath: string,
  clip: { id: string; trackId: string },
) =>
  agentCommand(page, projectPath, "SetSelection", {
    selection: { kind: "clip", id: clip.id, track_id: clip.trackId },
  });

async function clipIdentity(
  page: Page,
  which: "first" | "last",
): Promise<{ id: string; trackId: string }> {
  const clips = page.locator(".lane-row .clip-block");
  const clip = which === "first" ? clips.first() : clips.last();
  const id = await clip.getAttribute("data-clip-id");
  const trackId = await clip
    .locator("xpath=ancestor::*[@data-track-id][1]")
    .getAttribute("data-track-id");
  expect(id).toBeTruthy();
  expect(trackId).toBeTruthy();
  return { id: id as string, trackId: trackId as string };
}

test("a host tab keeps its own selection when another host tab selects, and an agent selection reaches both", async ({
  browser,
}) => {
  await withShareableProject(async (projectPath) => {
    await withTwoBrowserPages(
      browser,
      { viewport: DESKTOP },
      { viewport: DESKTOP },
      async (tabA, tabB) => {
        await openHostShare(tabA, projectPath);
        await openHostShare(tabB, projectPath);
        const selected = (page: Page) => page.locator(".clip-block.selected");
        const chosen = (page: Page, id: string) =>
          page.locator(`.clip-block.selected[data-clip-id="${id}"]`);
        const first = await clipIdentity(tabA, "first");
        const last = await clipIdentity(tabB, "last");
        expect(last.id).not.toBe(first.id);

        await tabA.locator(`[data-clip-id="${first.id}"] .clip-hit`).click();
        await expect(chosen(tabA, first.id)).toHaveCount(1);
        await tabB.waitForTimeout(SYNC_SETTLE_MS);
        await expect(selected(tabB)).toHaveCount(0);

        await tabB.locator(`[data-clip-id="${last.id}"] .clip-hit`).click();
        await expect(chosen(tabB, last.id)).toHaveCount(1);
        await tabA.waitForTimeout(SYNC_SETTLE_MS);
        await expect(chosen(tabA, first.id)).toHaveCount(1);
        await expect(selected(tabA)).toHaveCount(1);

        await agentSelectsClip(tabA, projectPath, last);
        await expect(chosen(tabA, last.id)).toHaveCount(1);
        await expect(chosen(tabB, last.id)).toHaveCount(1);

        await agentSelectsClip(tabA, projectPath, first);
        await expect(chosen(tabA, first.id)).toHaveCount(1);
        await expect(chosen(tabB, first.id)).toHaveCount(1);
        await tabA.locator(`[data-clip-id="${last.id}"] .clip-hit`).click();
        await expect(chosen(tabA, last.id)).toHaveCount(1);
        await tabB.waitForTimeout(SYNC_SETTLE_MS);
        await agentCommand(tabA, projectPath, "SetPlaying", {
          is_playing: false,
        });
        await tabB.waitForTimeout(SYNC_SETTLE_MS);
        await expect(chosen(tabB, first.id)).toHaveCount(1);
        await expect(chosen(tabA, last.id)).toHaveCount(1);
      },
    );
  });
});
