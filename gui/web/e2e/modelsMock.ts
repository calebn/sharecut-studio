import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";

/** The mocked `/api/bootstrap/*` and the viewport and theme matrix shared by the model specs. */

export type ModelRow = {
  id: string;
  label: string;
  purpose: string;
  tier: "required" | "recommended" | "offered";
  model: string;
  size: string;
  size_bytes: number | null;
  state: "installed" | "missing" | "update_needed";
};

export const ROWS: ModelRow[] = [
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

export const CATALOG = [
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

export type Job = Record<string, unknown>;

export function runningJob(components: string[], bytes = 420_000_000): Job {
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

export type Mock = {
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

export const idleStream = (job: Job | null) => (): string =>
  `retry: 3600000\n\n${job ? `data: ${JSON.stringify({ job })}\n\n` : ""}`;

export async function mockBootstrap(
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

export const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "844x390", width: 844, height: 390 },
  { name: "1440x900", width: 1440, height: 900 },
] as const;
export const THEMES = ["light", "dark"] as const;

export async function prepare(
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

export async function shot(
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

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

export function row(scope: Page | Locator, label: string): Locator {
  return scope.locator("li.model-row").filter({
    hasText: label,
  });
}

export async function expectTouchTargets(scope: Locator): Promise<void> {
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
