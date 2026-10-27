import { expect, type Locator, type Page } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";

export interface Box {
  top: number;
  bottom: number;
}

/** Suggest a 4–6 s cut on the first dialogue track, as an agent or guest would. */
export async function suggestOnFirstDialogueTrack(
  page: Page,
  projectPath: string,
  clientId: string,
): Promise<void> {
  const trackId = await page.evaluate(async (path) => {
    const res = await fetch(
      `/api/project?path=${encodeURIComponent(path)}&phase=shell`,
    );
    const project = (await res.json()) as {
      tracks: { id: string; role?: string }[];
    };
    return project.tracks.find((t) => t.role === "dialogue")?.id;
  }, projectPath);
  expect(trackId).toBeTruthy();
  await postDocumentCommand(
    page,
    clientId,
    "SuggestPendingEdit",
    { track_id: trackId, start: 4, end: 6, reason: "guest:suggest" },
    projectPath,
  );
}

/** Two animation frames: layout and the overlay's own frame-scheduled update have run. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** The rects the card must stay between; throws when the chrome is missing. */
export async function chromeBoxes(page: Page): Promise<{
  ruler: Box;
  marker: Box;
  panel: Box;
}> {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`${selector} is missing`);
      const { top, bottom } = el.getBoundingClientRect();
      return { top, bottom };
    };
    return {
      ruler: box(".time-ruler"),
      marker: box(".marker-lane"),
      panel: box(".stage-frame-player"),
    };
  });
}

/** True when the control's centre is what a pointer there would press. */
export async function isHitTestable(button: Locator): Promise<boolean> {
  return button.evaluate((el) => {
    const { left, top, width, height } = el.getBoundingClientRect();
    const hit = document.elementFromPoint(left + width / 2, top + height / 2);
    return hit !== null && el.contains(hit);
  });
}

export async function expectHitTestable(button: Locator): Promise<void> {
  await expect(button).toBeVisible();
  expect(await isHitTestable(button)).toBe(true);
}
