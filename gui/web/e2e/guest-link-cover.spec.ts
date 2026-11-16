import { expect, test } from "@playwright/test";
import { fontsReady } from "./fontsReady";
import { failBootstrap, press, SIZES, withGuestLink } from "./guestLink";

const ASLEEP_TITLE = "The host's computer is asleep";
const FAILED_TITLE = "This link did not load";
const TRACE_TEXT = "internal-trace-7c41e9";

for (const size of SIZES) {
  test.describe(`a review link that cannot load at ${size.width}x${size.height}`, () => {
    test("a press on Try now is answered on the same button, and a second failure is said aloud", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await failBootstrap(guest, token, "abort");
        await guest.goto(`/r/${token}`);
        const main = guest.getByRole("main");
        const button = main.getByRole("button", { name: "Try now" });
        await expect(button).toBeVisible();
        await button.evaluate((el) => {
          el.setAttribute("data-probe", "same-button");
        });

        await press(button, size.touch);

        const probe = main.locator("[data-probe=same-button]");
        await expect(probe).toHaveAttribute("aria-busy", "true", {
          timeout: 100,
        });
        await expect(
          main.getByRole("heading", { name: ASLEEP_TITLE }),
        ).toBeVisible();

        await expect(main.getByRole("status")).toHaveText("Still asleep.");
        await expect(probe).toBeVisible();
        await expect
          .poll(() =>
            guest.evaluate(
              () =>
                document.activeElement?.getAttribute("data-probe") ?? "none",
            ),
          )
          .toBe("same-button");
      });
    });

    test("the button keeps its place and size at rest, while busy and with the status showing", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        let open: () => void = () => {};
        const held = new Promise<void>((resolve) => {
          open = resolve;
        });
        let holding = false;
        await guest.route(`**/api/review/${token}/project`, async (route) => {
          if (holding) await held;
          await route.abort("connectionrefused");
        });
        await guest.goto(`/r/${token}`);
        const main = guest.getByRole("main");
        const button = main.getByRole("button", { name: "Try now" });
        await expect(button).toBeVisible();
        await fontsReady(guest);
        const rest = await button.boundingBox();

        holding = true;
        await press(button, size.touch);
        const busy = main.getByRole("button", { name: "Trying…" });
        await expect(busy).toHaveAttribute("aria-busy", "true");
        expect(await busy.boundingBox()).toEqual(rest);
        await expect(busy).toHaveCSS("opacity", "1");
        await expect(busy).toHaveCSS("cursor", "progress");

        open();
        await expect(main.getByRole("status")).toHaveText("Still asleep.");
        await expect(button).not.toHaveAttribute("aria-busy", "true");
        expect(await button.boundingBox()).toEqual(rest);
      });
    });

    test("the loading screen's Retry keeps its size and stays readable while it says Trying…", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await guest.clock.install();
        // The host never answers, so the screen offers Retry after 4 seconds.
        await guest.route(`**/api/review/${token}/project`, () => {});
        await guest.goto(`/r/${token}`);
        await guest.clock.runFor(4_500);
        const retry = guest.getByRole("button", { name: "Retry" });
        await expect(retry).toBeVisible();
        await fontsReady(guest);
        const rest = await retry.boundingBox();
        await press(retry, size.touch);
        const busy = guest.getByRole("button", { name: "Trying…" });
        await expect(busy).toHaveAttribute("aria-busy", "true");
        expect(await busy.boundingBox()).toEqual(rest);
        await expect(busy).toHaveCSS("opacity", "1");
        await expect(busy).toHaveCSS("cursor", "progress");
      });
    });

    test("the status line never touches the sentence, even with the text at 200%", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await failBootstrap(guest, token, "abort");
        await guest.goto(`/r/${token}`);
        await guest.addStyleTag({ content: "html { font-size: 200% }" });
        const main = guest.getByRole("main");
        const button = main.getByRole("button", { name: "Try now" });
        await expect(button).toBeVisible();
        await fontsReady(guest);
        await press(button, size.touch);
        const status = main.getByRole("status").getByText("Still asleep.");
        await expect(status).toBeVisible();
        const text = await main.locator(".sys-cover-text").boundingBox();
        const line = await status.boundingBox();
        expect(text).not.toBeNull();
        expect(line).not.toBeNull();
        expect(line!.y).toBeGreaterThanOrEqual(text!.y + text!.height);
      });
    });

    test("an HTTP 500 shows one plain sentence and none of the server's text", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await failBootstrap(guest, token, {
          status: 500,
          headers: { "content-type": "text/html" },
          body: `<html><body><h1>${TRACE_TEXT}</h1></body></html>`,
        });
        await guest.goto(`/r/${token}`);
        const main = guest.getByRole("main");
        await expect(
          main.getByRole("heading", { name: FAILED_TITLE }),
        ).toBeVisible();
        await expect(guest.locator("body")).not.toContainText(TRACE_TEXT);
        await expect(
          main.getByText(
            "Try again, and if it keeps happening, tell the person who sent it.",
          ),
        ).toBeVisible();
      });
    });

    test("a pressed Retry that nothing answers returns to Retry after 30 seconds", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await guest.clock.install();
        let asked = 0;
        await guest.route(`**/api/review/${token}/project`, async (route) => {
          asked += 1;
          if (asked === 1) {
            await route.fulfill({ status: 500, body: "" });
          }
          // Later requests are held: the host never answers.
        });
        await guest.goto(`/r/${token}`);
        const main = guest.getByRole("main");
        const retry = main.getByRole("button", { name: "Retry" });
        await press(retry, size.touch);
        const busy = main.getByRole("button", { name: "Trying…" });
        await expect(busy).toBeVisible();
        await guest.clock.runFor(29_000);
        await expect(busy).toBeVisible();
        await guest.clock.runFor(1_500);
        await expect(retry).toBeVisible();
        await expect(main.getByRole("status")).toHaveText("Still not loading.");
        await press(retry, size.touch);
        await expect.poll(() => asked).toBe(3);
      });
    });

    test("focus lands on the title, not on a framed page", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await failBootstrap(guest, token, "abort");
        await guest.goto(`/r/${token}`);
        await expect(
          guest.getByRole("heading", { name: ASLEEP_TITLE }),
        ).toBeVisible();

        await expect
          .poll(() =>
            guest.evaluate(() => {
              const active = document.activeElement;
              return active
                ? `${active.tagName}:${active.textContent}`
                : "none";
            }),
          )
          .toBe(`H1:${ASLEEP_TITLE}`);
        await expect(guest.getByRole("main")).not.toHaveAttribute("tabindex");

        const rings = await guest.evaluate(() => {
          const area = window.innerWidth * window.innerHeight;
          const drawn = (el: Element) => {
            const css = getComputedStyle(el);
            return (
              css.outlineStyle !== "none" && parseFloat(css.outlineWidth) > 0
            );
          };
          const around = Array.from(document.querySelectorAll("body *")).filter(
            (el) => {
              const box = el.getBoundingClientRect();
              return box.width * box.height >= area * 0.8 && drawn(el);
            },
          );
          return {
            window: around.map((el) => el.tagName),
            title: document.activeElement
              ? drawn(document.activeElement)
              : false,
          };
        });
        expect(rings).toEqual({ window: [], title: false });
      });
    });

    test("a busy host is not reported as asleep", async ({ browser }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await failBootstrap(guest, token, {
          status: 503,
          headers: {
            "content-type": "application/json",
            "x-sharecut-error-code": "project_busy",
          },
          body: JSON.stringify({ detail: "This project is busy; try again." }),
        });
        await guest.goto(`/r/${token}`);
        const main = guest.getByRole("main");
        await expect(
          main.getByRole("heading", { name: FAILED_TITLE }),
        ).toBeVisible();
        await expect(main.getByText(ASLEEP_TITLE)).toHaveCount(0);
      });
    });
  });
}
