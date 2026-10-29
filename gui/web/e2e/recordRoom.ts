import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { findCurrentTake } from "../src/record/types";
import { isPathInside } from "./pathInside";
import { openRecordRoom } from "./stageNav";
import { wavPeak } from "./wavPeak";

/** Record-share room as returned by `POST /api/shares/record`. */
export type RecordRoom = {
  session_id: string;
  guest: { token: string };
  producer: { token: string };
};

/**
 * Opt a page into the in-app E2E hooks. They only activate when the page URL
 * also carries `?e2e=1` (see `src/record/monitor/e2eHook.ts`).
 */
export async function markSharecutE2e(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __SHARECUT_E2E?: boolean }).__SHARECUT_E2E = true;
  });
}

/** Create a record room for `projectPath` through the host's API session. */
export async function createRecordRoom(
  host: Page,
  projectPath: string,
): Promise<RecordRoom> {
  const created = await host.request.post("/api/shares/record", {
    data: { path: projectPath },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const body = (await created.json()) as { room: RecordRoom };
  return body.room;
}

/** Path of the E2E-enabled `/rec/<token>` landing for a guest or producer. */
export function recordLinkPath(token: string): string {
  return `/rec/${encodeURIComponent(token)}?e2e=1`;
}

/** Navigate a guest or producer page to its record link. */
export async function openRecordLink(page: Page, token: string): Promise<void> {
  await page.goto(recordLinkPath(token));
}

export type HostRecordTakePause = {
  seq: number;
  pause_wall_ms: number;
  resume_wall_ms: number | null;
  pause_reason?: string | null;
};

export type HostRecordTake = {
  take_index: number;
  pauses: HostRecordTakePause[];
};

export type HostRecordSnapshot = {
  state?: string;
  session_id: string;
  take_index: number;
  recording_ms: number;
  participants: Array<{
    participant_id: string;
    display_name: string;
    connected?: boolean;
  }>;
  comments?: Array<{
    id: string;
    body: string;
    author: string;
    recording_ms: number;
  }>;
  pause_reason?: string | null;
  host_offline_since_wall_ms?: number | null;
  host_offline_gap_ms?: number | null;
  takes?: HostRecordTake[];
};

/**
 * The take at `snapshot.take_index` (`findCurrentTake` in
 * `src/record/types.ts`); throws when none matches. Stricter than the server's
 * `_current_take` (`services/record/state.py`), which falls back to the last
 * take around a take transition: a spec asserting on a take's pauses should
 * fail loudly on a mismatch rather than read another take. Poll the snapshot
 * until it settles before calling this across a take transition.
 */
export function currentTake(snapshot: HostRecordSnapshot): HostRecordTake {
  const take = findCurrentTake(snapshot);
  if (!take) {
    throw new Error("no open take in record snapshot");
  }
  return take;
}

export async function hostRecordSnapshot(
  host: Page,
  projectPath: string,
): Promise<HostRecordSnapshot> {
  const res = await host.request.get("/api/record/state", {
    params: { path: projectPath },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as HostRecordSnapshot;
}

export async function hostRecordState(
  host: Page,
  projectPath: string,
): Promise<string> {
  return (await hostRecordSnapshot(host, projectPath)).state ?? "";
}

export async function recordParticipantId(
  host: Page,
  projectPath: string,
  displayName: string,
): Promise<string> {
  const { participants } = await hostRecordSnapshot(host, projectPath);
  const id = participants.find(
    (participant) => participant.display_name === displayName,
  )?.participant_id;
  expect(
    id,
    `no record participant named ${displayName}; host sees ${JSON.stringify(participants)}`,
  ).toBeTruthy();
  return id as string;
}

/** Participant id of the host keeper (services/record/state.py). */
export const HOST_PARTICIPANT_ID = "p_host";

/** The Join sheet's name field. */
export function joinNameField(page: Page): Locator {
  return page.getByRole("textbox", { name: "Your name", exact: true });
}

/**
 * Fill the Join sheet's name and check that it holds `name`.
 *
 * The name lives in the page's own state and reaches the room through
 * `UpdateName` once the socket has joined, so a fill before the room echoes
 * this page's Join is safe (#764 lost it only when the old lobby remounted).
 */
export async function fillDisplayNameField(
  page: Page,
  name: string,
): Promise<void> {
  const field = joinNameField(page);
  await field.fill(name);
  await expect(field).toHaveValue(name);
}

/** The room's pill, which reads the phase: `Waiting for Sam to start`, `12:04 · Take 1`, `Saved`. */
export function roomPill(page: Page): Locator {
  return page.locator(".sys-room-view-header .sys-pill-text");
}

/** The tile whose accessible name starts with `name`, such as the guest's own. */
export function roomTile(page: Page, name: string): Locator {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("group", { name: new RegExp(`^${escaped}`) });
}

/** The alert slot's status row. */
export function roomAlertSlot(page: Page): Locator {
  return page.locator(".sys-room-alert-slot");
}

async function openAlertList(page: Page): Promise<void> {
  const chip = roomAlertSlot(page).getByRole("button", {
    name: /^\d+ more alerts?$/,
  });
  if (
    (await chip.count()) > 0 &&
    (await chip.getAttribute("aria-expanded")) === "false"
  ) {
    await chip.click();
  }
}

/**
 * Wait for an alert by its text. The slot shows only the most urgent alert, so
 * a lower one (the host dropped) can sit behind the "+N" chip while a higher
 * one (saving stopped during an outage) is on top: open the list to find it.
 */
export async function expectRoomAlert(
  page: Page,
  text: string | RegExp,
): Promise<void> {
  await expect(async () => {
    await openAlertList(page);
    await expect(roomAlertSlot(page).getByText(text)).toBeVisible({
      timeout: 1_000,
    });
  }).toPass();
}

/** Wait until no alert, top or behind the chip, carries `text`. */
export async function expectNoRoomAlert(
  page: Page,
  text: string | RegExp,
): Promise<void> {
  await expect(async () => {
    await openAlertList(page);
    await expect(roomAlertSlot(page).getByText(text)).toBeHidden({
      timeout: 1_000,
    });
  }).toPass();
}

/** Open the Notes rail (closed by default for a guest) and return its section. */
export async function openRoomNotes(page: Page): Promise<Locator> {
  const notes = page.getByRole("region", { name: "Notes", exact: true });
  if (!(await notes.isVisible())) {
    await page.getByRole("button", { name: "Notes", exact: true }).click();
  }
  await expect(notes).toBeVisible();
  return notes;
}

/**
 * Join a record link as a guest: name, microphone, headphones, Join and
 * record; returns once the room shows the pill and the guest's own tile.
 */
export async function joinAsGuest(
  page: Page,
  token: string,
  name: string,
): Promise<void> {
  await openRecordLink(page, token);
  await fillDisplayNameField(page, name);
  await page.getByRole("button", { name: "Allow microphone" }).click();
  const headphones = page.getByRole("button", {
    name: "I'm wearing headphones",
  });
  await headphones.click();
  await expect(headphones).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Join and record" }).click();
  await expect(
    page.getByRole("button", { name: "Join and record" }),
  ).toBeHidden();
  await expect(roomPill(page)).toHaveText(/^Waiting for .+ to start$/);
  // Registration signal for the name: the tile renders the room snapshot, the
  // same state `recordParticipantId` reads on the host.
  await expect(roomTile(page, name)).toBeVisible();
}

/**
 * Join a record link as a listen-only producer: name, Join to listen. The
 * producer never asks for the microphone.
 */
export async function joinAsProducer(
  page: Page,
  token: string,
  name: string,
): Promise<void> {
  await openRecordLink(page, token);
  await fillDisplayNameField(page, name);
  await page.getByRole("button", { name: "Join to listen" }).click();
  await expect(
    page.getByRole("button", { name: "Join to listen" }),
  ).toBeHidden();
  await expect(roomPill(page)).toHaveText(/^Waiting for .+ to start$/);
}

/**
 * Wait until each participant's keeper segments 0..n-1 in `takeIndex` are all
 * file-ACKed on the host. Pass only recorded participants (host, guests). A
 * producer or anyone who never opened a keeper has no rows and times out.
 */
export async function waitForSegmentsAcked(
  host: Page,
  projectPath: string,
  participantIds: string[],
  {
    takeIndex = 0,
    timeout = 60_000,
  }: { takeIndex?: number; timeout?: number } = {},
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await host.request.get("/api/record/upload", {
          params: { path: projectPath },
        });
        if (!res.ok()) return `upload status ${res.status()}`;
        const body = (await res.json()) as {
          segments?: Array<{
            participant_id?: string;
            take_index?: number;
            segment_index?: number;
            file_ack?: boolean;
          }>;
        };
        const waiting = participantIds.flatMap((pid) => {
          const segs = (body.segments ?? []).filter(
            (seg) => seg.participant_id === pid && seg.take_index === takeIndex,
          );
          if (segs.length === 0)
            return [`${pid}: no segments in take ${takeIndex}`];
          const indexes = segs
            .map((seg) => seg.segment_index ?? -1)
            .sort((x, y) => x - y);
          if (indexes.some((index, i) => index !== i)) {
            return [`${pid}: segment gap ${indexes.join(",")}`];
          }
          if (segs.some((seg) => seg.file_ack !== true)) {
            return [`${pid}: not file-ACKed`];
          }
          return [];
        });
        return waiting.length === 0
          ? "acked"
          : `waiting for ${waiting.join("; ")}`;
      },
      { timeout },
    )
    .toBe("acked");
}

/** Landed project JSON (the fields record specs read). */
export type SavedRecordProject = {
  sources: Array<{ id: string; path: string }>;
  timeline: {
    tracks: Array<{ id: string; label?: string }>;
    clips: Array<{
      track_id: string;
      source_id: string | null;
      timeline_start: number;
      source_start: number;
      source_end: number;
    }>;
  };
  review?: {
    comments: Array<{ body: string; author?: string; timeline_start: number }>;
  };
};

/** Read the project JSON the host GUI saved in the disposable workspace. */
export async function readSavedProject(
  projectPath: string,
): Promise<SavedRecordProject> {
  return JSON.parse(await readFile(projectPath, "utf8")) as SavedRecordProject;
}

/** `landedTrackPeak` found no landed track or clips yet; landing may still be committing. */
export class LandingPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LandingPendingError";
  }
}

/**
 * Peak (0..1, `wavPeak`) across every landed source WAV on the track labelled
 * `label`. Relies on the landing contract (`services/record/landing.py`):
 * every landed clip has a non-null `source_id` whose source path is under the
 * project's `raw/`. Throws when the track, its clips, a clip's `source_id` or
 * `raw/` source, or a file is missing, so a silent or absent landing cannot pass.
 */
export async function landedTrackPeak(
  projectPath: string,
  label: string,
): Promise<number> {
  const saved = await readSavedProject(projectPath);
  const track = saved.timeline.tracks.find((t) => t.label === label);
  if (!track) {
    throw new LandingPendingError(`no landed track labelled ${label}`);
  }
  const clips = saved.timeline.clips.filter((c) => c.track_id === track.id);
  if (clips.length === 0) {
    throw new LandingPendingError(`no landed clips on track labelled ${label}`);
  }
  const sourceIds = [...new Set(clips.map((c) => c.source_id))];
  const projectDir = path.dirname(projectPath);
  const rawDir = path.join(projectDir, "raw");
  let peak = 0;
  for (const sourceId of sourceIds) {
    if (sourceId === null) {
      throw new Error(
        `clip on track ${label} has no source_id (landing registers a raw/ source for every landed clip)`,
      );
    }
    const source = saved.sources.find((s) => s.id === sourceId);
    if (!source) {
      throw new Error(
        `clip on track ${label} references missing source ${sourceId}`,
      );
    }
    const resolved = path.resolve(projectDir, source.path);
    if (!isPathInside(rawDir, resolved)) {
      throw new Error(
        `source ${source.id} for track ${label} is not under raw/: ${source.path}`,
      );
    }
    const buf = await readFile(resolved);
    peak = Math.max(peak, wavPeak(new Uint8Array(buf)));
  }
  return peak;
}

/**
 * `landedTrackPeak`, or 0 while landing is still pending: no landed track or
 * clips yet (`LandingPendingError`), a missing project or WAV file (ENOENT),
 * or a half-written project JSON (`SyntaxError`). Every other error, such as a
 * null `source_id`, a missing source or a path outside `raw/`, is rethrown so
 * a structural landing regression fails an `expect.poll` right away with its
 * own message.
 */
export async function landedTrackPeakOrPending(
  projectPath: string,
  label: string,
): Promise<number> {
  try {
    return await landedTrackPeak(projectPath, label);
  } catch (error) {
    if (
      error instanceof LandingPendingError ||
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
    ) {
      return 0;
    }
    throw error;
  }
}

/**
 * Poll `/api/record/state` for `expectedState`; if it is not already there,
 * issue the transport command and poll until the host reports it. Tolerates
 * a POST rejected by a race that already landed the state.
 */
export async function ensureHostRecordCommand(
  host: Page,
  projectPath: string,
  commandType: string,
  expectedState: string,
): Promise<void> {
  if ((await hostRecordState(host, projectPath)) === expectedState) {
    return;
  }
  const started = await host.request.post("/api/record/command", {
    data: { path: projectPath, command_type: commandType, payload: {} },
  });
  if (!started.ok()) {
    if ((await hostRecordState(host, projectPath)) === expectedState) {
      return;
    }
    expect(started.ok(), await started.text()).toBeTruthy();
  }
  await expect
    .poll(async () => hostRecordState(host, projectPath))
    .toBe(expectedState);
}

/**
 * Click a host transport button and confirm it POSTed `/api/record/command`,
 * unless the state was already reached (a race with the previous click). The
 * request listener is removed before returning, so nothing outlives the call.
 */
export async function clickHostTransport(
  host: Page,
  button: Locator,
  projectPath: string,
  commandType: string,
  expectedState: string,
  { postTimeout = 5_000 }: { postTimeout?: number } = {},
): Promise<void> {
  let fired = false;
  const onRequest = (req: Request) => {
    if (req.method() === "POST" && req.url().includes("/api/record/command")) {
      fired = true;
    }
  };
  host.on("request", onRequest);
  try {
    await button.click();
    if ((await hostRecordState(host, projectPath)) === expectedState) {
      return;
    }
    await expect
      .poll(() => fired, {
        message: "host transport button did not POST /api/record/command",
        timeout: postTimeout,
      })
      .toBe(true);
  } finally {
    host.off("request", onRequest);
  }
  await ensureHostRecordCommand(host, projectPath, commandType, expectedState);
}

export function hostMoreDialog(scope: Page | Locator): Locator {
  const page = "page" in scope ? scope.page() : scope;
  return page.getByRole("dialog", { name: "More", exact: true });
}

export async function openHostMore(scope: Page | Locator): Promise<Locator> {
  const dialog = hostMoreDialog(scope);
  if (await dialog.isVisible()) {
    return dialog;
  }
  const page = "page" in scope ? scope.page() : scope;
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function openHostDevices(scope: Page | Locator): Promise<Locator> {
  const page = "page" in scope ? scope.page() : scope;
  const dialog = page.getByRole("dialog", { name: "Devices", exact: true });
  if (await dialog.isVisible()) {
    return dialog;
  }
  const more = await openHostMore(scope);
  await more.getByRole("button", { name: "Devices…", exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function closeHostMore(scope: Page | Locator): Promise<void> {
  const dialog = hostMoreDialog(scope);
  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
  }
}

/** Stop asks once in the More sheet; answer it and wait for the room to stop. */
export async function stopHostTake(
  host: Page,
  room: Locator,
  projectPath: string,
): Promise<void> {
  const more = await openHostMore(room);
  await more.getByRole("button", { name: "Stop take", exact: true }).click();
  await clickHostTransport(
    host,
    more.getByRole("button", { name: "Stop take", exact: true }),
    projectPath,
    "Stop",
    "stopped",
  );
  await expect(more).toBeHidden();
}

/** Open the host's Record stage and return its root. */
export async function openHostRecordRoom(host: Page): Promise<Locator> {
  return openRecordRoom(host);
}

/**
 * Wait for the take to land on the timeline from the More sheet: click Land
 * when it is enabled, or accept that auto-land already finished it (the
 * disabled Land button then carries "Every take is on the timeline.").
 */
export async function landParticipant(
  room: Locator,
  _name: string,
): Promise<void> {
  const more = await openHostMore(room);
  const landButton = more.getByRole("button", { name: /^(Retry )?Land$/ });
  const landedTitle = "Every take is on the timeline.";
  const state = async () => {
    if ((await landButton.getAttribute("title")) === landedTitle) {
      return "landed";
    }
    return (await landButton.isEnabled()) ? "land" : "waiting";
  };
  await expect.poll(state, { timeout: 60_000 }).not.toBe("waiting");
  if ((await state()) === "land") {
    await landButton.click({ timeout: 5_000 }).catch(async (error: unknown) => {
      if ((await state()) !== "landed") throw error;
    });
  }
  await expect(landButton).toHaveAttribute("title", landedTitle, {
    timeout: 60_000,
  });
}

/**
 * Whether the host's own socket (participant `p_host`) is currently reported
 * connected by `/api/record/state`. A closed host `/api/host/ws` submits a
 * `Leave` for the host participant (`services/record/service.py`
 * `disconnect`), so this flips false while the host's socket is down and true
 * again once it reconnects and the host `Join` lands.
 */
export async function hostRecordConnected(
  host: Page,
  projectPath: string,
): Promise<boolean> {
  const { participants } = await hostRecordSnapshot(host, projectPath);
  return (
    participants.find((p) => p.participant_id === HOST_PARTICIPANT_ID)
      ?.connected === true
  );
}

/**
 * Assert that reminting a record room for `projectPath` is refused with 409
 * while a take is open (REC/PAUSED), per `TAKE_OPEN_REMINT_MSG`
 * (`services/record/state.py`).
 */
export async function expectRemintRefused(
  host: Page,
  projectPath: string,
): Promise<void> {
  const res = await host.request.post("/api/shares/record", {
    data: { path: projectPath },
  });
  expect(res.status()).toBe(409);
  const text = await res.text();
  expect(text).toContain("Stop it before minting a new room");
}
