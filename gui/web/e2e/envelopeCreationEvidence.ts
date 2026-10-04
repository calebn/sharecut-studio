import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  expect,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";
import { repoRoot } from "./env";
import type { InteractionReceipt } from "./interactionEvidence";
import { createRelocatedE2eProject } from "./liveProject";

export async function openEnvelopeTrackDetails(
  page: Page,
  label: string,
  receipts: InteractionReceipt[],
) {
  const button = page.getByRole("button", {
    name: `Open track details, ${label}`,
    exact: true,
  });
  await expect(button).toBeVisible();
  await button.scrollIntoViewIfNeeded();
  const geometry = await button.evaluate((element) => {
    const row = element.closest(".track-header-row");
    const visible = (candidate: Element | null) => {
      if (!candidate) return false;
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility === "visible" &&
        style.display !== "none"
      );
    };
    const chip = row?.querySelector(".track-chip") ?? null;
    const title = row?.querySelector(".track-title") ?? null;
    const identity = visible(chip) ? chip : visible(title) ? title : null;
    if (!identity)
      throw new Error("Track identity has no visible title or chip");
    const identityRect = identity.getBoundingClientRect();
    const buttonRect = element.getBoundingClientRect();
    const x = identityRect.left + identityRect.width / 2;
    const y = identityRect.top + identityRect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const style = getComputedStyle(element);
    return {
      identity: identity.className,
      identityRect: identityRect.toJSON(),
      buttonRect: buttonRect.toJSON(),
      viewport: { width: innerWidth, height: innerHeight },
      point: { x, y },
      position: {
        x: x - buttonRect.left - Number.parseFloat(style.borderLeftWidth),
        y: y - buttonRect.top - Number.parseFloat(style.borderTopWidth),
      },
      insideButton:
        x > buttonRect.left &&
        x < buttonRect.right &&
        y > buttonRect.top &&
        y < buttonRect.bottom,
      insideViewport: x > 0 && x < innerWidth && y > 0 && y < innerHeight,
      hitsButton: hit === element || (hit !== null && element.contains(hit)),
      hit: hit ? { tag: hit.tagName, className: hit.className } : null,
    };
  });
  receipts.push({
    checkpoint: "track-identity-hit-admission",
    observation: { label, ...geometry },
  });
  expect(geometry.insideButton).toBe(true);
  expect(geometry.insideViewport).toBe(true);
  expect(geometry.hitsButton).toBe(true);
  await button.click({ position: geometry.position });
}

export type EnvelopePoint = { id: string; time: number; value: number };
export type EnvelopeCommand = {
  type: string;
  command_id: string;
  client_id: string;
  client_seq: number;
  payload: {
    track_id?: string;
    points?: EnvelopePoint[];
    expected_points?: EnvelopePoint[];
  };
};
type SavedProject = {
  timeline: { tracks: { id: string; label: string }[]; clips: unknown[] };
  mix: {
    automation_envelopes: {
      track_id: string;
      parameter: string;
      points: EnvelopePoint[];
    }[];
    [key: string]: unknown;
  };
  sources: unknown;
  processing: unknown;
  editorial: unknown;
  social: unknown;
};
export type EnvelopeSnapshot = {
  points: EnvelopePoint[];
  otherEnvelopes: unknown[];
  unchanged: {
    timeline: unknown;
    sources: unknown;
    processing: unknown;
    editorial: unknown;
    social: unknown;
    mix: unknown;
  };
  history: {
    cursor: number;
    entries: {
      id: string;
      label: string;
      operation: string | null;
      params: unknown;
    }[];
  } | null;
};
export function emptyEnvelopeProject(prefix: string) {
  const fixture = createRelocatedE2eProject(prefix);
  const saved = JSON.parse(
    fs.readFileSync(fixture.projectPath, "utf8"),
  ) as SavedProject;
  expect(saved.timeline.tracks.length).toBeGreaterThan(0);
  expect(saved.mix.automation_envelopes).toEqual([]);
  expect(
    fs.existsSync(path.join(fixture.workspaceDir, "history", "index.json")),
  ).toBe(false);
  expect(fs.existsSync(path.join(fixture.workspaceDir, "sync.db"))).toBe(false);
  for (const filename of ["sync.db", "document.db"])
    expect(
      fs.existsSync(
        path.join(fixture.workspaceDir, "artifacts", "session", filename),
      ),
    ).toBe(false);
  return fixture;
}
export function envelopeTrack(projectPath: string) {
  const saved = JSON.parse(
    fs.readFileSync(projectPath, "utf8"),
  ) as SavedProject;
  const track = saved.timeline.tracks[0];
  if (!track) throw new Error("Empty envelope fixture requires a source track");
  return track;
}
export function envelopeSnapshot(
  projectPath: string,
  trackId: string,
): EnvelopeSnapshot {
  const saved = JSON.parse(
    fs.readFileSync(projectPath, "utf8"),
  ) as SavedProject;
  const { automation_envelopes, ...mix } = saved.mix;
  const historyPath = path.join(
    path.dirname(projectPath),
    "history",
    "index.json",
  );
  return {
    points:
      automation_envelopes.find(
        (item) => item.track_id === trackId && item.parameter === "volume",
      )?.points ?? [],
    otherEnvelopes: automation_envelopes.filter(
      (item) => item.track_id !== trackId || item.parameter !== "volume",
    ),
    unchanged: {
      timeline: saved.timeline,
      sources: saved.sources,
      processing: saved.processing,
      editorial: saved.editorial,
      social: saved.social,
      mix,
    },
    history: fs.existsSync(historyPath)
      ? (JSON.parse(
          fs.readFileSync(historyPath, "utf8"),
        ) as EnvelopeSnapshot["history"])
      : null,
  };
}
export function expectEnvelopeMutation(
  before: EnvelopeSnapshot,
  after: EnvelopeSnapshot,
  trackId: string,
) {
  expect(after.unchanged).toEqual(before.unchanged);
  expect(after.otherEnvelopes).toEqual(before.otherEnvelopes);
  const baseCursor = Math.max(0, before.history?.cursor ?? -1);
  expect(after.history?.cursor).toBe(baseCursor + 1);
  expect(after.history?.entries).toHaveLength(baseCursor + 2);
  if (before.history)
    expect(after.history?.entries.slice(0, before.history.cursor + 1)).toEqual(
      before.history.entries.slice(0, before.history.cursor + 1),
    );
  expect(after.history?.entries[baseCursor + 1]).toMatchObject({
    label: `after set envelope ${trackId}`,
  });
}
export async function acceptedEnvelopeCommand(
  page: Page,
  type: string,
  action: () => Promise<unknown>,
) {
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/document/command" &&
      (response.request().postDataJSON() as EnvelopeCommand).type === type,
  );
  const [, response] = await Promise.all([action(), pending]);
  const command = response.request().postDataJSON() as EnvelopeCommand;
  const reply: unknown = await response.json();
  expect(response.status()).toBe(200);
  expect(command.command_id).toEqual(expect.stringMatching(/\S/));
  expect(command.client_id).toEqual(expect.stringMatching(/\S/));
  expect(Number.isInteger(command.client_seq)).toBe(true);
  expect(reply).toMatchObject({
    ok: true,
    type: "Applied",
    command: {
      type,
      command_id: command.command_id,
      client_id: command.client_id,
      client_seq: command.client_seq,
    },
  });
  return { command, reply, status: response.status() };
}
export function observeEnvelopeCommands(
  page: Page,
  projectPath: string,
  trackId: string,
  receipts: InteractionReceipt[],
) {
  const commands: EnvelopeCommand[] = [];
  let lastStage = "fixture-ready";
  const sourcePaths = [
    "gui/web/e2e/envelope-creation.spec.ts",
    "gui/web/e2e/envelope-conflicts.spec.ts",
    "gui/web/e2e/envelope-permissions.spec.ts",
    "gui/web/e2e/envelopeCreationEvidence.ts",
    "gui/web/e2e/envelopePlaybackEvidence.ts",
    "gui/web/src/inspector/views/EnvelopeWorkspace.tsx",
    "gui/web/src/inspector/views/EnvelopeWorkspaceView.tsx",
    "gui/web/dist/index.html",
  ];
  receipts.push({
    checkpoint: "envelope-run-inputs",
    observation: {
      fixture: {
        path: projectPath,
        sha256: createHash("sha256")
          .update(fs.readFileSync(projectPath))
          .digest("hex"),
      },
      source: Object.fromEntries(
        sourcePaths.map((relative) => [
          relative,
          createHash("sha256")
            .update(fs.readFileSync(path.join(repoRoot, relative)))
            .digest("hex"),
        ]),
      ),
    },
  });
  const assets: {
    path: string;
    status: number;
    expected: string | null;
    actual: string | null;
    error?: string;
  }[] = [];
  const assetReads: Promise<void>[] = [];
  const expectedAssets = new Map<string, string>();
  const dist = path.join(repoRoot, "gui/web/dist");
  for (const relative of fs.readdirSync(dist, { recursive: true })) {
    const name = String(relative).split(path.sep).join("/");
    if (!name.endsWith(".js") && !name.endsWith(".css")) continue;
    expectedAssets.set(
      `/${name}`,
      createHash("sha256")
        .update(fs.readFileSync(path.join(dist, name)))
        .digest("hex"),
    );
  }
  const assetListener = (response: Response) => {
    const url = new URL(response.url());
    if (!url.pathname.endsWith(".js") && !url.pathname.endsWith(".css")) return;
    const row = {
      path: url.pathname,
      status: response.status(),
      expected: expectedAssets.get(url.pathname) ?? null,
      actual: null as string | null,
      error: undefined as string | undefined,
    };
    assets.push(row);
    assetReads.push(
      response
        .body()
        .then(
          (body) => {
            row.actual = createHash("sha256").update(body).digest("hex");
          },
          () => {
            row.error = "Response body unavailable";
          },
        )
        .then(() => {
          receipts.push({
            checkpoint: "served-production-asset",
            observation: { ...row },
          });
        }),
    );
  };
  page.on("response", assetListener);
  const replies: unknown[] = [];
  const pending: Promise<void>[] = [];
  const requestListener = (request: Request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/document/command"
    )
      commands.push(request.postDataJSON() as EnvelopeCommand);
  };
  const responseListener = (response: Response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/document/command"
    )
      return;
    pending.push(
      response.json().then(
        (body: unknown) => {
          replies.push({ status: response.status(), body });
        },
        (error: unknown) => {
          replies.push({ status: response.status(), bodyError: String(error) });
        },
      ),
    );
  };
  page.on("request", requestListener);
  page.on("response", responseListener);
  return {
    commands,
    async verifyAssets() {
      await Promise.all(assetReads);
      expect(assets.some((asset) => asset.path.endsWith(".js"))).toBe(true);
      expect(assets.some((asset) => asset.path.endsWith(".css"))).toBe(true);
      for (const asset of assets) {
        expect(asset.status, asset.path).toBe(200);
        expect(asset.error, asset.path).toBeUndefined();
        expect(asset.expected, asset.path).not.toBeNull();
        expect(asset.actual, asset.path).toBe(asset.expected);
      }
    },
    stage(name: string) {
      lastStage = name;
      receipts.push({
        checkpoint: `attempt-${name}`,
        observation: { commandCount: commands.length },
      });
    },
    async retain() {
      page.off("response", assetListener);
      page.off("request", requestListener);
      page.off("response", responseListener);
      await Promise.allSettled([...pending, ...assetReads]);
      receipts.push({
        checkpoint: "envelope-terminal-commands",
        observation: { lastStage, commands, replies },
      });
      try {
        receipts.push({
          checkpoint: "envelope-terminal-saved",
          observation: envelopeSnapshot(projectPath, trackId),
        });
      } catch (error) {
        receipts.push({
          checkpoint: "envelope-terminal-snapshot-error",
          observation: { error: String(error) },
        });
      }
    },
  };
}
