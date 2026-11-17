import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { assertDisposableE2eProject, e2eProjectPath } from "./env";
import { fontsReady } from "./fontsReady";
import {
  expectServerWordsAbsent,
  type FailedAnswer,
  failShell,
  focusWhenSeen,
  lastLineWordCount,
  MARKER_500,
  press,
  SERVER_MARKER,
  SIZES,
  type Size,
  watchFocusWhenSeen,
  withGuestLink,
} from "./guestLink";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject, withShareableProject } from "./shareableProject";
import { waitForFrame } from "./stageNav";

/**
 * The studio's own load-failure cover: the first read of the episode fails
 * after the studio has opened. It says one fixed sentence chosen from the kind
 * of failure and never what the server answered, for a guest and for a host.
 */

const GUEST_TITLE = "The transcript didn't load";
const HOST_TITLE = "Could not load the project";
const ASLEEP_TITLE = "The host's computer is asleep";
const OFFLINE_TITLE = "You're offline";
const NOT_SERVED_TITLE = "This episode isn't open on this computer";

const SERVER_SENTENCE =
  "Try again, and if it keeps happening, tell the person who sent it.";
const ASLEEP_SENTENCE = "This page tries again every 30 seconds.";
const INTERCEPTED_SENTENCE =
  "This network did not pass the page through; on public Wi-Fi, sign in to the Wi-Fi first, then try again.";
const BUSY_SENTENCE =
  "This episode is busy for a moment; this page tries again every 30 seconds.";
const DOUBT_SENTENCE = "That didn't go through. Try again in a moment.";
const RATE_LIMITED_SENTENCE =
  "This link is busy right now; this page tries again in a moment.";

const json = (status: number, body: unknown, code?: string): FailedAnswer => ({
  status,
  headers: {
    "content-type": "application/json",
    ...(code ? { "x-sharecut-error-code": code } : {}),
  },
  body: JSON.stringify(body),
});
const markerAnswers = {
  "a 500 with the marker in JSON": MARKER_500,
  "a 500 with the marker as plain text": {
    status: 500,
    headers: { "content-type": "text/plain" },
    body: SERVER_MARKER,
  },
  "a 500 with the marker in an HTML page": {
    status: 500,
    headers: { "content-type": "text/html" },
    body: `<html><body><h1>${SERVER_MARKER}</h1></body></html>`,
  },
} satisfies Record<string, FailedAnswer>;
const HTML_200: FailedAnswer = {
  status: 200,
  headers: { "content-type": "text/html" },
  body: `<html><body><h1>${SERVER_MARKER}</h1></body></html>`,
};
const RELAY_503 = json(503, {
  detail: "host offline",
  message:
    "This review link is valid, but the project host is not connected. Ask them to run podcast tunnel.",
});

/** Words no reader may meet beside the marker: the relay's command and the server's own path text. */
const NEVER_READ = ["ZEBRA", "hunter2", "podcast tunnel", "Project not found"];

type Expected = {
  title: string;
  sentence: string;
  /** Buttons in reading order. */
  buttons: string[];
};

async function expectCover(page: Page, expected: Expected): Promise<Locator> {
  const cover = page.getByRole("alert");
  await expect(
    cover.getByRole("heading", { name: expected.title }),
  ).toBeVisible();
  await expect(cover.locator(".sys-cover-text")).toHaveText(expected.sentence);
  await expect(cover.getByRole("button")).toHaveCount(expected.buttons.length);
  for (const [i, name] of expected.buttons.entries()) {
    await expect(cover.getByRole("button").nth(i)).toHaveAccessibleName(name);
  }
  await expectServerWordsAbsent(page, NEVER_READ);
  return cover;
}

const hostName = (projectPath: string) =>
  path.basename(path.dirname(projectPath));

async function openHostWithoutProject(page: Page, projectPath: string) {
  assertDisposableE2eProject(projectPath);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await waitForFrame(page);
}

async function pressOn(cover: Locator, name: string, size: Size) {
  await press(cover.getByRole("button", { name }), size.touch);
}

const GUEST_ANSWERS: [string, FailedAnswer, Expected][] = [
  ...Object.entries(markerAnswers).map(
    ([name, fail]): [string, FailedAnswer, Expected] => [
      name,
      fail,
      {
        title: GUEST_TITLE,
        sentence: SERVER_SENTENCE,
        buttons: ["Try again"],
      },
    ],
  ),
  [
    "a 200 with an HTML page",
    HTML_200,
    {
      title: GUEST_TITLE,
      sentence: INTERCEPTED_SENTENCE,
      buttons: ["Try again"],
    },
  ],
  [
    "a 404 with no code",
    json(404, { detail: SERVER_MARKER }),
    { title: GUEST_TITLE, sentence: SERVER_SENTENCE, buttons: ["Try again"] },
  ],
  [
    "a 404 that says the link is gone, while the link is alive",
    json(404, { detail: SERVER_MARKER }, "share_not_found"),
    { title: GUEST_TITLE, sentence: DOUBT_SENTENCE, buttons: ["Try again"] },
  ],
  [
    "a 503 from the relay",
    RELAY_503,
    { title: ASLEEP_TITLE, sentence: ASLEEP_SENTENCE, buttons: ["Try now"] },
  ],
  [
    "a refused connection",
    "abort",
    { title: ASLEEP_TITLE, sentence: ASLEEP_SENTENCE, buttons: ["Try now"] },
  ],
  [
    "a 503 that says the episode is busy",
    json(503, { detail: SERVER_MARKER }, "project_busy"),
    { title: GUEST_TITLE, sentence: BUSY_SENTENCE, buttons: ["Try again"] },
  ],
];

const HOST_NOT_ANSWERING = (): Expected => ({
  title: HOST_TITLE,
  sentence:
    "ShareCut isn't answering. Check that it is still running on this computer.",
  buttons: ["Try again"],
});

function hostAnswers(name: string): [string, FailedAnswer, Expected][] {
  const other: Expected = {
    title: HOST_TITLE,
    sentence: `ShareCut couldn't open "${name}". If a newer version of ShareCut saved it, update ShareCut first.`,
    buttons: ["Try again", "All projects"],
  };
  return [
    ...Object.entries(markerAnswers).map(
      ([label, fail]): [string, FailedAnswer, Expected] => [label, fail, other],
    ),
    ["a 200 with an HTML page", HTML_200, other],
    [
      "a 404 that names the episode's folder",
      json(
        404,
        { detail: `Project not found: /home/secret/${SERVER_MARKER}` },
        "project_not_found",
      ),
      {
        title: HOST_TITLE,
        sentence: `ShareCut can't find "${name}". Its folder may have been moved, renamed or deleted.`,
        buttons: ["All projects", "Try again"],
      },
    ],
    [
      "a 500 that says the file is damaged",
      json(500, { detail: SERVER_MARKER }, "project_unreadable"),
      {
        title: HOST_TITLE,
        sentence: `ShareCut can't read "${name}" because its file is damaged. Restore the file from a backup, or open a copy of the episode.`,
        buttons: ["All projects", "Try again"],
      },
    ],
    [
      "a 503 that says the episode is busy",
      json(503, { detail: SERVER_MARKER }, "project_busy"),
      {
        title: HOST_TITLE,
        sentence: "Something else is using this episode for a moment.",
        buttons: ["Try again"],
      },
    ],
    [
      "a 503 with no code",
      json(503, { detail: SERVER_MARKER }),
      HOST_NOT_ANSWERING(),
    ],
    ["a refused connection", "abort", HOST_NOT_ANSWERING()],
  ];
}

for (const size of SIZES) {
  test.describe(`a studio whose first read fails at ${size.width}x${size.height}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.touch,
    });

    for (const [name, fail, expected] of GUEST_ANSWERS) {
      test(`a guest reads one fixed sentence for ${name}, and Try again recovers`, async ({
        browser,
      }) => {
        test.setTimeout(90_000);
        await withGuestLink(browser, size, async (guest, token) => {
          const shell = await failShell(guest, { token }, fail);
          await guest.goto(`/r/${token}`);
          const cover = await expectCover(guest, expected);

          shell.lift();
          await pressOn(cover, expected.buttons[0]!, size);
          await expect(cover).toBeHidden();
        });
      });
    }

    for (const [name, fail, expected] of hostAnswers(
      hostName(e2eProjectPath),
    )) {
      test(`a host reads one fixed sentence for ${name}, and the way back works`, async ({
        page,
      }) => {
        const shell = await failShell(page, "host", fail);
        await openHostWithoutProject(page, e2eProjectPath);
        const cover = await expectCover(page, expected);

        shell.lift();
        await pressOn(cover, "Try again", size);
        await expect(cover).toBeHidden();
      });
    }

    test("a host's press answered by a different cover puts focus on Try again as the new sentence appears", async ({
      page,
    }) => {
      const name = hostName(e2eProjectPath);
      const shell = await failShell(
        page,
        "host",
        json(404, { detail: SERVER_MARKER }, "project_not_found"),
      );
      await openHostWithoutProject(page, e2eProjectPath);
      const cover = page.getByRole("alert");
      await expect(cover.getByRole("button").first()).toHaveAccessibleName(
        "All projects",
      );

      shell.answerWith(MARKER_500);
      await watchFocusWhenSeen(page, "update ShareCut first");
      await cover.getByRole("button", { name: "Try again" }).focus();
      await pressOn(cover, "Try again", size);
      expect(await focusWhenSeen(page)).toBe("retry");
      await expect(cover).toContainText(`couldn't open "${name}"`);
    });

    test("a host's press answered by missing after other puts focus on Try again as the new sentence appears", async ({
      page,
    }) => {
      const shell = await failShell(page, "host", MARKER_500);
      await openHostWithoutProject(page, e2eProjectPath);
      const cover = page.getByRole("alert");
      await expect(cover.getByRole("button").first()).toHaveAccessibleName(
        "Try again",
      );

      shell.answerWith(
        json(404, { detail: SERVER_MARKER }, "project_not_found"),
      );
      await watchFocusWhenSeen(page, "Its folder may have been moved");
      await cover.getByRole("button", { name: "Try again" }).focus();
      await pressOn(cover, "Try again", size);
      expect(await focusWhenSeen(page)).toBe("retry");
      await expect(cover.getByRole("button").first()).toHaveAccessibleName(
        "All projects",
      );
    });

    if (!size.touch) {
      test("a guest on Review whose press is answered by a sign-in has focus on the cover's title", async ({
        browser,
      }) => {
        test.setTimeout(90_000);
        await withGuestLink(browser, size, async (guest, token) => {
          const shell = await failShell(guest, { token }, MARKER_500);
          await guest.goto(`/r/${token}`);
          const cover = await expectCover(guest, {
            title: GUEST_TITLE,
            sentence: SERVER_SENTENCE,
            buttons: ["Try again"],
          });

          shell.answerWith(json(401, { detail: SERVER_MARKER }));
          await watchFocusWhenSeen(guest, "needs a sign-in");
          await cover.getByRole("button", { name: "Try again" }).focus();
          await pressOn(cover, "Try again", size);
          expect(await focusWhenSeen(guest)).toBe(`h2:${GUEST_TITLE}`);
        });
      });
    }

    test("a host's long project name wraps inside the cover and the page does not scroll sideways", async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await withShareableProject(async () => {
        const long = createRelocatedE2eProject("n".repeat(64));
        try {
          await switchE2eProject(long.projectPath);
          await failShell(page, "host", MARKER_500);
          await openHostWithoutProject(page, long.projectPath);
          const cover = page.getByRole("alert");
          await expect(
            cover.getByText(hostName(long.projectPath)),
          ).toBeVisible();
          const reach = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth,
            view: document.documentElement.clientWidth,
            cover: Math.max(
              ...[
                ...document.querySelectorAll('[role="alert"] .sys-cover-text'),
              ].map((el) => el.getBoundingClientRect().right),
            ),
          }));
          expect(reach.page).toBeLessThanOrEqual(reach.view);
          expect(reach.cover).toBeLessThanOrEqual(reach.view);
        } finally {
          removeRelocatedE2eProject(long.workspaceDir);
        }
      });
    });

    test("a guest's press is answered on the same button and in a status line, and the sentence never changes", async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      await withGuestLink(browser, size, async (guest, token) => {
        const shell = await failShell(guest, { token }, MARKER_500);
        await guest.goto(`/r/${token}`);
        const cover = guest.getByRole("alert");
        await expect(
          cover.getByRole("button", { name: "Try again" }),
        ).toBeVisible();
        await cover.getByRole("button").evaluate((el) => {
          el.setAttribute("data-probe", "same-button");
        });
        // The button's name changes while it is busy; the probe finds it still.
        const button = cover.locator("[data-probe=same-button]");
        await guest.evaluate(() => {
          const watched = document.querySelector(".sys-cover-text");
          const seen = { changes: 0 };
          Object.assign(window, { __sentenceChanges: seen });
          if (watched) {
            new MutationObserver(() => {
              seen.changes += 1;
            }).observe(watched, {
              childList: true,
              characterData: true,
              subtree: true,
            });
          }
        });

        for (let i = 0; i < 3; i++) {
          await press(button, size.touch);
          await expect(button).toHaveAttribute("aria-busy", "true", {
            timeout: 1_000,
          });
          await expect(cover.getByRole("status")).toHaveText(
            "Still not loading.",
          );
          await expect(button).not.toHaveAttribute("aria-busy", "true");
          expect(
            await guest.evaluate(
              () =>
                document.activeElement?.getAttribute("data-probe") ?? "none",
            ),
          ).toBe("same-button");
        }
        expect(
          await guest.evaluate(
            () =>
              (window as unknown as { __sentenceChanges: { changes: number } })
                .__sentenceChanges.changes,
          ),
        ).toBe(0);
        await expect(cover.locator(".sys-cover-text")).toHaveText(
          SERVER_SENTENCE,
        );

        shell.lift();
        await press(button, size.touch);
        await expect(cover).toBeHidden();
      });
    });

    test("a host's press says Still not answering., keeps the button and its focus, and the cover has no accessibility violations", async ({
      page,
    }) => {
      const shell = await failShell(page, "host", "abort");
      await openHostWithoutProject(page, e2eProjectPath);
      const cover = await expectCover(page, HOST_NOT_ANSWERING());
      await expectPageAxeClean(page, '[role="alert"]');
      const button = cover.getByRole("button", { name: "Try again" });
      await button.evaluate((el) => {
        el.setAttribute("data-probe", "same-button");
      });
      await press(button, size.touch);
      await expect(cover.getByRole("status")).toHaveText(
        "Still not answering.",
      );
      expect(
        await page.evaluate(
          () => document.activeElement?.getAttribute("data-probe") ?? "none",
        ),
      ).toBe("same-button");

      // A host's cover never tries again by itself.
      await page.clock.install();
      const before = shell.requests();
      await page.clock.runFor(300_000);
      expect(shell.requests()).toBe(before);
    });

    test("a guest's asleep cover tries again by itself after 30 seconds", async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      await withGuestLink(browser, size, async (guest, token) => {
        await guest.clock.install();
        const shell = await failShell(guest, { token }, RELAY_503);
        await guest.goto(`/r/${token}`);
        const cover = await expectCover(guest, {
          title: ASLEEP_TITLE,
          sentence: ASLEEP_SENTENCE,
          buttons: ["Try now"],
        });
        await expectPageAxeClean(guest, '[role="alert"]');
        shell.lift();
        await guest.clock.runFor(30_000);
        await expect(cover).toBeHidden();
      });
    });

    test("a guest's rate-limited cover waits as long as the link asked", async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      await withGuestLink(browser, size, async (guest, token) => {
        await guest.clock.install();
        const shell = await failShell(
          guest,
          { token },
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "5",
              "x-sharecut-error-code": "rate_limited",
            },
            body: JSON.stringify({ detail: SERVER_MARKER }),
          },
        );
        await guest.goto(`/r/${token}`);
        const cover = await expectCover(guest, {
          title: GUEST_TITLE,
          sentence: RATE_LIMITED_SENTENCE,
          buttons: ["Try again"],
        });
        shell.lift();
        await guest.clock.runFor(5_000);
        await expect(cover).toBeHidden();
      });
    });

    test("a guest whose device goes offline reads You're offline, and the page opens by itself when the connection is back", async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      await withGuestLink(browser, size, async (guest, token) => {
        const shell = await failShell(guest, { token }, "abort");
        await guest.goto(`/r/${token}`);
        const cover = await expectCover(guest, {
          title: ASLEEP_TITLE,
          sentence: ASLEEP_SENTENCE,
          buttons: ["Try now"],
        });
        await guest.context().setOffline(true);
        await pressOn(cover, "Try now", size);
        await expectCover(guest, {
          title: OFFLINE_TITLE,
          sentence:
            "This page opens the episode by itself when your connection is back.",
          buttons: ["Try now"],
        });
        shell.lift();
        await guest.context().setOffline(false);
        await expect(cover).toBeHidden();
      });
    });
  });
}

test.describe("a host whose computer is open on another episode", () => {
  test.describe("at phone width", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("the title keeps more than one word on its last line", async ({
      page,
    }) => {
      await failShell(
        page,
        "host",
        json(403, { detail: SERVER_MARKER }, "project_path_not_allowed"),
      );
      await openHostWithoutProject(page, e2eProjectPath);
      const title = page.getByRole("alert").getByRole("heading");
      await expect(title).toHaveText(NOT_SERVED_TITLE);
      await fontsReady(page);
      expect(await lastLineWordCount(title)).toBeGreaterThan(1);
    });
  });

  test("reads that, and All projects goes Home without closing the other episode", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await withShareableProject(async (projectPath) => {
      const other = createRelocatedE2eProject("sharecut-e2e-other-");
      try {
        const closes: string[] = [];
        page.on("request", (request) => {
          if (request.url().includes("/api/project/close")) {
            closes.push(request.url());
          }
        });
        const shell = await failShell(page, "host", MARKER_500);
        await openHostWithoutProject(page, projectPath);
        const cover = await expectCover(page, {
          title: HOST_TITLE,
          sentence: `ShareCut couldn't open "${hostName(projectPath)}". If a newer version of ShareCut saved it, update ShareCut first.`,
          buttons: ["Try again", "All projects"],
        });

        // A second window opens another episode; the first window's load runs again.
        await switchE2eProject(other.projectPath);
        shell.lift();
        await cover.getByRole("button", { name: "Try again" }).click();
        await expectCover(page, {
          title: NOT_SERVED_TITLE,
          sentence: "This computer is open on a different episode.",
          buttons: ["All projects"],
        });
        await expectPageAxeClean(page, '[role="alert"]');

        await cover.getByRole("button", { name: "All projects" }).click();
        await expect(page).toHaveURL(/home=1/);
        expect(closes).toEqual([]);

        // The other episode is still the one this computer has open.
        await page.goto(`/?project=${encodeURIComponent(other.projectPath)}`);
        await waitForFrame(page);
      } finally {
        removeRelocatedE2eProject(other.workspaceDir);
      }
    });
  });

  test("All projects on a missing episode closes it and goes Home", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await withShareableProject(async (projectPath) => {
      await failShell(
        page,
        "host",
        json(404, { detail: "Project not found: /x" }, "project_not_found"),
      );
      await openHostWithoutProject(page, projectPath);
      const cover = page.getByRole("alert");
      await cover.getByRole("button", { name: "All projects" }).click();
      await expect(page).toHaveURL(/home=1/);
    });
  });
});
