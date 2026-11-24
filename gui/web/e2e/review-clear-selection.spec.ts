import {
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { withGuestLink } from "./guestLink";
import { openGuestShare } from "./shareNavigation";
import { goToStage } from "./stageNav";
import { SCRIPT_SELECTED } from "./transcriptEdit";

const SIZES = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "tablet", width: 820, height: 1180, touch: true },
  { name: "desktop", width: 1280, height: 800, touch: false },
] as const;

const WRITES = /\/(daw\/)?document\/command|\/comments?\b|\/suggest/;

async function playhead(page: Page): Promise<string> {
  const time = page.getByText(/^\d\d:\d\d\.\d{3}$/).first();
  return (await time.count()) === 0 ? "" : ((await time.textContent()) ?? "");
}

async function expectClearRoundTrip(
  page: Page,
  script: Locator,
  touch: boolean,
  stableHeader: boolean,
) {
  const writes: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "GET" && WRITES.test(req.url()))
      writes.push(req.url());
  });
  const word = script.locator(".sys-script-word").nth(2);
  const wordsBefore = await script.locator(".sys-script-word").count();
  const clear = page.getByRole("button", {
    name: "Clear selection",
    exact: true,
  });
  await expect(clear).toHaveCount(0);
  const top = async () => (await word.boundingBox())?.y;
  const topBefore = await top();
  if (touch) await word.tap();
  else await word.click();
  await expect(script.locator(SCRIPT_SELECTED)).toHaveCount(1);
  await expect(
    clear,
    "a visible Clear selection control is shown while words are selected",
  ).toBeVisible({ timeout: 3000 });
  if (touch) {
    const box = await clear.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  if (stableHeader) expect(await top()).toBe(topBefore);
  const at = await playhead(page);
  if (touch) await clear.tap();
  else await clear.click();
  await expect(script.locator(SCRIPT_SELECTED)).toHaveCount(0);
  await expect(clear).toHaveCount(0);
  if (stableHeader) expect(await top()).toBe(topBefore);
  expect(await playhead(page)).toBe(at);
  await expect(script.locator(".sys-script-word")).toHaveCount(wordsBefore);
  expect(writes).toEqual([]);
  await expect(
    word.or(
      page
        .getByRole("searchbox")
        .or(page.getByRole("textbox", { name: /find/i })),
    ),
  ).toBeFocused();
}

async function runShare(
  browser: Browser,
  size: (typeof SIZES)[number],
  role: "commenter" | "editor",
) {
  await withGuestLink(
    browser,
    size,
    async (guest, token) => {
      await openGuestShare(guest, token);
      if (role === "editor") await goToStage(guest, "review");
      const script = guest.locator(".stage-host-guest-script");
      await expect(script.locator(".sys-script-word").first()).toBeVisible();
      await expectClearRoundTrip(guest, script, size.touch, size.width === 390);
    },
    role,
  );
}

for (const size of SIZES) {
  test(`${size.name} ${size.width}x${size.height}: a Commenter clears selected words in Review`, async ({
    browser,
  }) => {
    await runShare(browser, size, "commenter");
  });
}

test("desktop 1280x800: an Editor clears selected words in Review", async ({
  browser,
}) => {
  await runShare(browser, SIZES[2], "editor");
});
