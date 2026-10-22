import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectReadingSurfaceAxeClean, expectSurfaceAxeClean } from "./axe";
import { openHostProject } from "./overlayReachability";

/**
 * The first-run wizard and the Models dialog against a mocked `/api/bootstrap/*`: nothing here
 * downloads anything. Set MODELS_SHOTS_DIR to also save one screenshot per viewport, theme and case.
 */

type ModelRow = {
  id: string;
  label: string;
  purpose: string;
  tier: "required" | "recommended" | "offered";
  model: string;
  size: string;
  size_bytes: number | null;
  state: "installed" | "missing" | "update_needed";
};

const ROWS: ModelRow[] = [
  {
    id: "whisper",
    label: "Whisper",
    purpose: "transcription",
    tier: "required",
    model: "large-v3-turbo",
    size: "~1.6 GB",
    size_bytes: 1_600_000_000,
    state: "missing",
  },
  {
    id: "rnnoise",
    label: "Noise reduction (RNNoise)",
    purpose: "noise reduction",
    tier: "recommended",
    model: "rnnoise",
    size: "~0.3 MB",
    size_bytes: 297_646,
    state: "missing",
  },
  {
    id: "word-aligner",
    label: "Word aligner",
    purpose: "precise word boundaries",
    tier: "offered",
    model: "wav2vec2",
    size: "~360 MB",
    size_bytes: null,
    state: "missing",
  },
  {
    id: "speaker-ecapa",
    label: "Speaker model",
    purpose: "speaker recognition and split",
    tier: "offered",
    model: "speaker-ecapa",
    size: "~25 MB",
    size_bytes: null,
    state: "missing",
  },
];

const CATALOG = [
  {
    id: "large-v3-turbo",
    label: "Recommended",
    size: "~1.6 GB",
    description: "Lowest practical error for podcasts (multilingual). Default.",
  },
  {
    id: "small.en",
    label: "Balanced (English)",
    size: "~500 MB",
    description: "Good laptop default if disk is tight.",
  },
];

type Job = Record<string, unknown>;

function runningJob(components: string[], bytes = 420_000_000): Job {
  return {
    id: "job-1",
    kind: "bootstrap",
    components,
    whisper_model: "large-v3-turbo",
    status: "running",
    message: "Downloading Whisper",
    download: { component: components[0], bytes, total: 1_600_000_000 },
  };
}

type Mock = {
  rows: ModelRow[];
  job: Job | null;
  runs: unknown[];
  /** Answers POST /run; return null to let the default (a running job) answer. */
  runResponse?: (
    body: { components: string[] },
    mock: Mock,
  ) => {
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  };
  /** The body of GET /events, as SSE frames. */
  events: (mock: Mock) => string;
};

const idleStream = (job: Job | null) => (): string =>
  `retry: 3600000\n\n${job ? `data: ${JSON.stringify({ job })}\n\n` : ""}`;

async function mockBootstrap(
  page: Page,
  options: {
    rows?: ModelRow[];
    job?: Job | null;
    runResponse?: Mock["runResponse"];
    events?: Mock["events"];
    ffmpeg?: "installed" | "missing";
  } = {},
): Promise<Mock> {
  const mock: Mock = {
    rows: options.rows ?? ROWS.map((r) => ({ ...r })),
    job: options.job ?? null,
    runs: [],
    runResponse: options.runResponse,
    events: options.events ?? ((m) => idleStream(m.job)()),
  };
  const isPath = (name: string) => (url: URL) =>
    url.pathname === `/api/bootstrap/${name}`;
  await page.route(isPath("status"), async (route) => {
    const variant = new URL(route.request().url()).searchParams.get(
      "whisper_model",
    );
    const rows = mock.rows.map((r) =>
      r.id === "whisper" && variant === "small.en"
        ? { ...r, model: "small.en", size: "~500 MB", size_bytes: 500_000_000 }
        : r,
    );
    const required = rows.filter((r) => r.tier === "required");
    await route.fulfill({
      json: {
        ready:
          (options.ffmpeg ?? "installed") === "installed" &&
          required.every((r) => r.state === "installed"),
        cdn_base: false,
        whisper_model: variant ?? "large-v3-turbo",
        whisper_models: CATALOG,
        tools: {
          ffmpeg: {
            state: options.ffmpeg ?? "installed",
            source: "bundled",
            hint: null,
          },
        },
        models: rows,
      },
    });
  });
  await page.route(isPath("status-job"), (route) =>
    route.fulfill({ json: { job: mock.job } }),
  );
  await page.route(isPath("events"), (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: mock.events(mock),
    }),
  );
  await page.route(isPath("cancel"), (route) =>
    route.fulfill({ json: { job: mock.job } }),
  );
  await page.route(isPath("run"), async (route) => {
    const body = route.request().postDataJSON() as { components: string[] };
    mock.runs.push(body);
    const answer = mock.runResponse?.(body, mock);
    if (answer) {
      await route.fulfill({
        status: answer.status,
        headers: answer.headers,
        json: answer.body,
      });
      return;
    }
    mock.job = runningJob(body.components);
    await route.fulfill({ json: { job: mock.job, adopted: false } });
  });
  return mock;
}

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "844x390", width: 844, height: 390 },
  { name: "1440x900", width: 1440, height: 900 },
] as const;
const THEMES = ["light", "dark"] as const;

async function prepare(
  page: Page,
  theme: (typeof THEMES)[number],
  skip: boolean,
): Promise<void> {
  await page.addInitScript(
    ({ theme, skip }) => {
      window.localStorage.setItem("daw_theme", theme);
      if (skip) {
        window.localStorage.setItem("sharecut.bootstrap.skip", "1");
      }
    },
    { theme, skip },
  );
}

async function shot(
  page: Page,
  viewport: string,
  theme: string,
  name: string,
  fullPage = false,
): Promise<void> {
  const dir = process.env.MODELS_SHOTS_DIR;
  if (dir) {
    await page.screenshot({
      path: path.join(dir, `${viewport}-${theme}-${name}.png`),
      fullPage,
    });
  }
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

function row(scope: Page | Locator, label: string): Locator {
  return scope.locator("li.model-row").filter({
    hasText: label,
  });
}

async function expectTouchTargets(scope: Locator): Promise<void> {
  const min = await scope.page().evaluate(() => {
    const probe = document.createElement("div");
    probe.style.blockSize = "var(--touch-min)";
    document.body.append(probe);
    const px = probe.getBoundingClientRect().height;
    probe.remove();
    return px;
  });
  for (const control of await scope
    .locator("button, input[type=checkbox], select")
    .all()) {
    if (!(await control.isVisible())) continue;
    const label = control.locator("xpath=ancestor-or-self::*[self::label][1]");
    const target = (await label.count()) > 0 ? label : control;
    const box = await target.boundingBox();
    expect(
      box?.height ?? 0,
      `${await control.evaluate((el) => el.outerHTML.slice(0, 90))} is under --touch-min`,
    ).toBeGreaterThanOrEqual(min - 1);
  }
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`models ${viewport.name} ${theme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
      });

      test("wizard lists required, recommended and offered rows, and downloads nothing", async ({
        page,
      }) => {
        await prepare(page, theme, false);
        const mock = await mockBootstrap(page);
        await page.goto("/?home=1");
        const setup = page.getByRole("region", { name: "Setup" });
        await expect(
          setup.getByRole("heading", { name: "Set up ShareCut Studio" }),
        ).toBeVisible();
        await expect(page.locator("li.model-row")).toHaveCount(4);
        await expect(
          page
            .locator("li.model-row")
            .evaluateAll((els) =>
              els.map((el) => el.getAttribute("data-model")),
            ),
        ).resolves.toEqual([
          "whisper",
          "rnnoise",
          "word-aligner",
          "speaker-ecapa",
        ]);
        const whisper = setup.getByRole("checkbox", { name: "Whisper" });
        await expect(whisper).toBeChecked();
        await expect(whisper).toBeDisabled();
        await expect(whisper).toHaveAccessibleDescription(
          /Required for transcription/,
        );
        await expect(
          setup.getByRole("checkbox", { name: "Noise reduction (RNNoise)" }),
        ).toBeChecked();
        await expect(
          setup.getByRole("checkbox", { name: "Word aligner" }),
        ).not.toBeChecked();
        await expect(
          setup.getByRole("checkbox", { name: "Speaker model" }),
        ).not.toBeChecked();
        await expect(
          row(page, "Whisper").getByRole("combobox", { name: "Whisper size" }),
        ).toBeVisible();
        await expect(setup.getByText("Download 1.6 GB")).toBeVisible();
        await expect(
          setup.getByText("You can download these later from Models."),
        ).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectTouchTargets(setup);
        await expectReadingSurfaceAxeClean(page);
        await shot(page, viewport.name, theme, "wizard-initial", true);
        expect(mock.runs).toEqual([]);
      });

      test("Continue shows the live bar on the current row and the others waiting", async ({
        page,
      }) => {
        await prepare(page, theme, false);
        const mock = await mockBootstrap(page);
        await page.goto("/?home=1");
        const setup = page.getByRole("region", { name: "Setup" });
        await setup.getByRole("button", { name: "Continue" }).click();
        await expect.poll(() => mock.runs.length).toBe(1);
        expect(mock.runs[0]).toMatchObject({
          components: ["whisper", "rnnoise"],
        });
        const bar = row(page, "Whisper").getByRole("progressbar");
        await expect(bar).toHaveAttribute("aria-valuetext", "420 MB of 1.6 GB");
        await expect(bar).toHaveAttribute("value", "420000000");
        await expect(
          row(page, "Noise reduction (RNNoise)").getByRole("status"),
        ).toHaveText("Waiting");
        await expect(
          setup.getByRole("button", { name: "Downloading…" }),
        ).toBeDisabled();
        await expectNoHorizontalScroll(page);
        await expectReadingSurfaceAxeClean(page);
        await shot(page, viewport.name, theme, "wizard-downloading", true);
      });

      test("Models opens from Home with the skip flag and shows every state", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        const rows = ROWS.map((r) => ({ ...r }));
        rows[0]!.state = "installed";
        rows[1]!.state = "update_needed";
        const failure = {
          kind: "http",
          status: 404,
          plain: "The download server doesn't have the speaker model.",
        };
        const mock = await mockBootstrap(page, {
          rows,
          events: () =>
            `retry: 3600000\n\ndata: ${JSON.stringify({
              job: {
                id: "job-1",
                kind: "bootstrap",
                components: ["speaker-ecapa"],
                whisper_model: "large-v3-turbo",
                status: "error",
                error: failure.plain,
                failure,
                result: {
                  results: {
                    "speaker-ecapa": {
                      ok: false,
                      error: failure.plain,
                      failure,
                    },
                  },
                },
              },
            })}\n\n`,
        });
        await page.goto("/?home=1");
        await expect(
          page.getByRole("heading", { name: "ShareCut Studio" }),
        ).toBeVisible();
        await expect(page.getByRole("region", { name: "Setup" })).toHaveCount(
          0,
        );
        await page.getByRole("button", { name: "Models", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Models" });
        await expect(dialog).toBeVisible();
        await expect(row(dialog, "Whisper").getByRole("status")).toHaveText(
          "Installed",
        );
        await expect(
          row(dialog, "Noise reduction (RNNoise)").getByRole("status"),
        ).toHaveText("Update available");
        await expect(
          row(dialog, "Noise reduction (RNNoise)").getByRole("button", {
            name: "Update Noise reduction (RNNoise)",
          }),
        ).toBeEnabled();
        await expect(
          row(dialog, "Word aligner").getByRole("status"),
        ).toHaveText("Not downloaded");
        await row(dialog, "Speaker model")
          .getByRole("button", { name: "Download Speaker model" })
          .click();
        const failed = row(dialog, "Speaker model");
        await expect(failed.getByRole("alert")).toHaveText(failure.plain);
        await expect(failed.getByRole("status")).toHaveText("Download failed");
        await expect(
          failed.getByText(/Try again in a few minutes/),
        ).toBeVisible();
        await expect(
          failed.getByRole("button", { name: "Retry Speaker model" }),
        ).toBeEnabled();
        expect(mock.runs).toHaveLength(1);
        await expectNoHorizontalScroll(page);
        await expectTouchTargets(dialog);
        await expectReadingSurfaceAxeClean(page);
        await shot(page, viewport.name, theme, "dialog-states");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      });

      test("a 409 on Download adopts the running job and disables the other buttons with a reason", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        const mock = await mockBootstrap(page, {
          runResponse: (_body, m) => {
            m.job = runningJob(["whisper"]);
            return {
              status: 409,
              headers: { "X-Sharecut-Error-Code": "bootstrap_job_running" },
              body: {
                detail: "Another download is already running (whisper)",
                running: ["whisper"],
                cancelling: false,
              },
            };
          },
        });
        await page.goto("/?home=1");
        await page.getByRole("button", { name: /^Models/ }).click();
        const dialog = page.getByRole("dialog", { name: "Models" });
        await expect(dialog).toBeVisible();

        // Short landscape: the sheet body scrolls and the first row's action stays reachable.
        const body = dialog.locator(".command-palette-body");
        const scrolls = await body.evaluate(
          (el) => el.scrollHeight > el.clientHeight,
        );
        if (viewport.height <= 400) {
          expect(scrolls, "the sheet body scrolls on a short screen").toBe(
            true,
          );
        }
        const whisperDownload = row(dialog, "Whisper").getByRole("button", {
          name: "Download Whisper",
        });
        await whisperDownload.scrollIntoViewIfNeeded();
        await expect(whisperDownload).toBeInViewport();

        await row(dialog, "Word aligner")
          .getByRole("button", { name: "Download Word aligner" })
          .click();
        await expect.poll(() => mock.runs.length).toBe(1);
        const bar = row(dialog, "Whisper").getByRole("progressbar");
        await expect(bar).toHaveAttribute("aria-valuetext", "420 MB of 1.6 GB");
        for (const [label, name] of [
          ["Noise reduction (RNNoise)", "Download Noise reduction (RNNoise)"],
          ["Word aligner", "Download Word aligner"],
          ["Speaker model", "Download Speaker model"],
        ] as const) {
          const button = row(dialog, label).getByRole("button", { name });
          await expect(button).toBeDisabled();
          await expect(button).toHaveAccessibleDescription(
            "Another download is running",
          );
        }
        await expect(
          row(dialog, "Whisper").getByRole("button", {
            name: "Cancel Whisper download",
          }),
        ).toBeEnabled();
        expect(mock.runs).toHaveLength(1);
        await expectNoHorizontalScroll(page);
        await expectTouchTargets(dialog);
        await expectReadingSurfaceAxeClean(page);
        await shot(page, viewport.name, theme, "dialog-busy-409");
      });
    });
  }
}

test.describe("models palette command 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of THEMES) {
    test(`Manage models… opens the dialog from a project (${theme})`, async ({
      page,
    }) => {
      await prepare(page, theme, true);
      const mock = await mockBootstrap(page);
      await openHostProject(page);
      await page.keyboard.press("Shift+Slash");
      const search = page.getByRole("combobox", { name: "Search commands" });
      await expect(search).toBeVisible();
      await search.fill("Manage models");
      await expect(
        page.getByRole("option", { name: /Manage models…/ }),
      ).toBeVisible();
      await page.getByRole("option", { name: /Manage models…/ }).click();
      const dialog = page.getByRole("dialog", { name: "Models" });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("li.model-row")).toHaveCount(4);
      await expectSurfaceAxeClean(page, ".command-palette-panel");
      await shot(page, "1440x900", theme, "palette-opens-dialog");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(mock.runs).toEqual([]);
    });
  }
});

test.describe("models dialog in a project on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("rises as a bottom sheet with every row reachable", async ({ page }) => {
    await prepare(page, "light", true);
    const mock = await mockBootstrap(page);
    await openHostProject(page);
    await page.keyboard.press("Shift+Slash");
    await page
      .getByRole("combobox", { name: "Search commands" })
      .fill("Manage models");
    await page.getByRole("option", { name: /Manage models…/ }).click();
    const dialog = page.getByRole("dialog", { name: "Models" });
    await expect(dialog).toBeVisible();
    const panel = dialog.locator(".command-palette-panel");
    // The sheet rises into place; wait for it to settle on the bottom edge.
    await expect
      .poll(async () => {
        const box = await panel.boundingBox();
        return box && Math.round(box.y + box.height);
      })
      .toBe(844);
    const last = row(dialog, "Speaker model").getByRole("button", {
      name: "Download Speaker model",
    });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await expectNoHorizontalScroll(page);
    await expectSurfaceAxeClean(page, ".command-palette-panel");
    await shot(page, "390x844", "light", "palette-sheet");
    expect(mock.runs).toEqual([]);
  });
});
