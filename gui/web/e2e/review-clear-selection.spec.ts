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
  { name: "narrow phone", width: 320, height: 568, touch: true },
  { name: "small phone", width: 375, height: 667, touch: true },
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "tablet", width: 820, height: 1180, touch: true },
  { name: "desktop", width: 1280, height: 800, touch: false },
] as const;
const ROLES = ["commenter", "editor"] as const;

const WRITES = /\/(daw\/)?document\/command|\/comments?\b|\/suggest/;

async function playhead(page: Page): Promise<string> {
  const time = page.getByText(/^\d\d:\d\d\.\d{3}$/).first();
  return (await time.count()) === 0 ? "" : ((await time.textContent()) ?? "");
}

async function expectClearRoundTrip(
  page: Page,
  script: Locator,
  touch: boolean,
) {
  const writes: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "GET" && WRITES.test(req.url()))
      writes.push(req.url());
  });
  const word = script.locator(".sys-script-word").first();
  const wordsBefore = await script.locator(".sys-script-word").count();
  const clear = page.getByRole("button", {
    name: "Clear selection",
    exact: true,
  });
  await expect(clear).toHaveCount(0);
  const header = script.locator(".sys-script-header");
  // The Editor's transcript on a small phone is under 70 px tall, and selecting a word there scrolls it 2 px to reveal the word. The word's place in the transcript is what Clear must not move.
  const placed = async () => ({
    header: await header.boundingBox(),
    word: await word.evaluate(
      (el) =>
        el.getBoundingClientRect().y +
        (el.closest(".sys-script-body")?.scrollTop ?? 0),
    ),
  });
  const before = await placed();
  expect(
    before.header,
    "the Script header is drawn before any selection",
  ).not.toBeNull();
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
  expect(
    await placed(),
    "a selection moves neither the header nor the word",
  ).toEqual(before);
  const at = await playhead(page);
  if (touch) await clear.tap();
  else await clear.click();
  await expect(script.locator(SCRIPT_SELECTED)).toHaveCount(0);
  await expect(clear).toHaveCount(0);
  expect(
    await placed(),
    "clearing moves neither the header nor the word",
  ).toEqual(before);
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
  role: (typeof ROLES)[number],
) {
  await withGuestLink(
    browser,
    size,
    async (guest, token) => {
      await openGuestShare(guest, token);
      if (role === "editor") await goToStage(guest, "review");
      const script = guest.locator(".stage-host-guest-script");
      await expect(script.locator(".sys-script-word").first()).toBeVisible();
      await expectClearRoundTrip(guest, script, size.touch);
    },
    role,
  );
}

for (const size of SIZES) {
  for (const role of ROLES) {
    test(`${size.name} ${size.width}x${size.height}: ${role === "editor" ? "an Editor" : "a Commenter"} clears selected words in Review without moving the header or the text`, async ({
      browser,
    }) => {
      await runShare(browser, size, role);
    });
  }
}
