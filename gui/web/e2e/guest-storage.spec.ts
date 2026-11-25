import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { failBootstrap } from "./guestLink";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { setTheme, withAppearance } from "./theme";
import { withBrowserPages } from "./twoBrowserPages";
import { hostEditsTheAudio, twoCopiesProject } from "./twoCopiesProject";

const BLOCKED_SENTENCE =
  "Your browser isn't letting this page keep a saved copy. The page still works while the host answers. If the host stops, what you write here is lost when you close the page.";
const FULL_SENTENCE =
  "This device has no room to keep a saved copy. The page still works while the host answers. If the host stops, what you write here is lost when you close the page.";
const PREFS_SENTENCE =
  "This browser isn't keeping your settings. They reset when you reload.";
const LIGHT = "Not kept on this device";
const ASLEEP_TITLE = "The host's computer is asleep";

type Probe = { said: string[]; failures: number; earlyFailures: number };

async function watch(page: Page) {
  await page.addInitScript(() => {
    const probe: Probe = { said: [], failures: 0, earlyFailures: 0 };
    (window as unknown as { __probe: Probe }).__probe = probe;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          const region = node.parentElement?.closest(
            "[role=status][aria-live]",
          );
          const text = node.textContent?.trim();
          if (region && text) probe.said.push(text);
        }
    }).observe(document, { subtree: true, childList: true });
  });
}

const probe = (page: Page) =>
  page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);

const timesSaid = async (page: Page, sentence: string) =>
  (await probe(page)).said.filter((text) => text === sentence).length;

const STUBS = {
  blockedDatabase: () => {
    IDBFactory.prototype.open = () => {
      (window as unknown as { __probe: Probe }).__probe.failures++;
      throw new DOMException("blocked", "SecurityError");
    };
  },
  fullDatabase: () => {
    IDBObjectStore.prototype.put = () => {
      (window as unknown as { __probe: Probe }).__probe.failures++;
      throw new DOMException("full", "QuotaExceededError");
    };
  },
  fullDatabaseRequest: () => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      const transaction = this.transaction;
      put.call(this, value, key);
      const duplicate = this.add(value, key);
      duplicate.addEventListener("error", () => {
        Object.defineProperty(duplicate, "error", {
          value: new DOMException("full", "QuotaExceededError"),
        });
        const state = (window as unknown as { __probe: Probe }).__probe;
        state.failures++;
        if (!transaction.error) state.earlyFailures++;
      });
      return duplicate;
    };
  },
  blockedLocalStorage: () => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
  },
  fullLocalStorage: () => {
    Storage.prototype.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
  },
};

type Stub = keyof typeof STUBS;

async function withStubbedGuest(
  browser: Parameters<typeof withBrowserPages>[0],
  page: Page,
  stub: Stub,
  theme: "light" | "dark",
  run: (guest: Page, token: string, projectPath: string) => Promise<void>,
) {
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      await withBrowserPages(
        browser,
        [{ viewport: { width: 390, height: 844 }, hasTouch: true }],
        async ([guest]) => {
          const token = await createReviewShare(page, projectPath, "commenter");
          const errors: string[] = [];
          guest!.on("pageerror", (error) => errors.push(error.message));
          await watch(guest!);
          await guest!.addInitScript(STUBS[stub]);
          await openGuestShare(guest!, token);
          await setTheme(guest!, theme);
          await run(guest!, token, projectPath);
          expect(errors).toEqual([]);
        },
      );
    },
    undefined,
    twoCopiesProject,
  );
}

const light = (guest: Page) => guest.locator(".sys-save").first();

async function oneMoreWrite(guest: Page, page: Page, projectPath: string) {
  const before = (await probe(guest)).failures;
  await hostEditsTheAudio(page, projectPath);
  await expect
    .poll(async () => (await probe(guest)).failures)
    .toBeGreaterThan(before);
}

for (const { cell, theme } of withAppearance(["blocked", "full"] as const)) {
  const stub: Stub = cell === "blocked" ? "blockedDatabase" : "fullDatabase";
  const sentence = cell === "blocked" ? BLOCKED_SENTENCE : FULL_SENTENCE;
  test(`a guest whose device ${cell === "blocked" ? "will not open its database" : "has no room for a write"} is told once, in the light, and never that a save failed`, async ({
    browser,
    page,
  }) => {
    await withStubbedGuest(
      browser,
      page,
      stub,
      theme,
      async (guest, token, projectPath) => {
        await expect(light(guest)).toContainText(LIGHT);
        await expect(light(guest)).toHaveAttribute("title", sentence);
        await expect(guest.getByText("Save failed")).toHaveCount(0);
        await expect(guest.getByRole("alert")).toHaveCount(0);
        await expect.poll(() => timesSaid(guest, sentence)).toBe(1);
        await oneMoreWrite(guest, page, projectPath);
        await expect(light(guest)).toContainText(LIGHT);
        expect(await timesSaid(guest, sentence)).toBe(1);
        expect(
          (await probe(guest)).said.filter((text) =>
            /Saved edits could not be read/.test(text),
          ),
        ).toEqual([]);
        await expectPageAxeClean(guest);

        await failBootstrap(guest, token, "abort");
        await guest.reload();
        const main = guest.getByRole("main");
        await expect(
          main.getByRole("heading", { name: ASLEEP_TITLE }),
        ).toBeVisible();
        if (cell === "blocked") {
          await expect(main).toContainText(BLOCKED_SENTENCE);
          await expectPageAxeClean(guest);
        } else {
          // A copy that was never written cannot be told from one that was never offered, so the cover stays plain.
          await expect(main).not.toContainText("saved copy");
        }
      },
    );
  });
}

test("a request that runs out of room tells the guest that the device is full", async ({
  browser,
  page,
}) => {
  await withStubbedGuest(
    browser,
    page,
    "fullDatabaseRequest",
    "light",
    async (guest) => {
      await expect
        .poll(async () => (await probe(guest)).earlyFailures)
        .toBeGreaterThan(0);
      await expect(light(guest)).toContainText(LIGHT);
      await expect(light(guest)).toHaveAttribute("title", FULL_SENTENCE);
      await expect.poll(() => timesSaid(guest, FULL_SENTENCE)).toBe(1);
      await expect(guest.getByText("Save failed")).toHaveCount(0);
    },
  );
});

for (const { cell, theme } of withAppearance(
  ["blockedLocalStorage", "fullLocalStorage"] as const,
  1,
)) {
  test(`a guest whose browser keeps no settings (${cell}) hears it once, and the light stays Saved`, async ({
    browser,
    page,
  }) => {
    await withStubbedGuest(browser, page, cell, theme, async (guest) => {
      await expect(light(guest)).toHaveText("Saved");
      await guest
        .getByRole("button", { name: "Explain Commenter role" })
        .click();
      await expect.poll(() => timesSaid(guest, PREFS_SENTENCE)).toBe(1);
      await expect(light(guest)).toHaveText("Saved");
      await expect(guest.getByRole("alert")).toHaveCount(0);
      await expectPageAxeClean(guest);
    });
  });
}
