import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
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

export type HostRecordSnapshot = {
  state?: string;
  session_id: string;
  take_index: number;
  recording_ms: number;
  participants: Array<{ participant_id: string; display_name: string }>;
  comments?: Array<{
    id: string;
    body: string;
    author: string;
    recording_ms: number;
  }>;
};

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
  const id = (await hostRecordSnapshot(host, projectPath)).participants.find(
    (participant) => participant.display_name === displayName,
  )?.participant_id;
  expect(id, `no record participant named ${displayName}`).toBeTruthy();
  return id as string;
}

/** Participant id of the host keeper (services/record/state.py). */
export const HOST_PARTICIPANT_ID = "p_host";

/** Join a record link as a guest: name, headphones, mic, skip room tone, Accept. */
export async function joinAsGuest(
  page: Page,
  token: string,
  name: string,
): Promise<void> {
  await openRecordLink(page, token);
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("I am wearing headphones").check();
  await page.getByRole("button", { name: "Allow microphone" }).click();
  await expect(page.getByLabel("Level")).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Waiting for host")).toBeVisible();
}

/** Join a record link as a listen-only producer. */
export async function joinAsProducer(
  page: Page,
  token: string,
  name: string,
): Promise<void> {
  await openRecordLink(page, token);
  await page.getByLabel("Display name").fill(name);
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByText("Waiting for host")).toBeVisible();
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

/**
 * Peak (0..1, `wavPeak`) across every landed source WAV on the track labelled
 * `label`. Throws when the track, its clips, a clip's `raw/` source or a file
 * is missing, so a silent or absent landing cannot pass.
 */
export async function landedTrackPeak(
  projectPath: string,
  label: string,
): Promise<number> {
  const saved = await readSavedProject(projectPath);
  const track = saved.timeline.tracks.find((t) => t.label === label);
  if (!track) {
    throw new Error(`no landed track labelled ${label}`);
  }
  const clips = saved.timeline.clips.filter((c) => c.track_id === track.id);
  if (clips.length === 0) {
    throw new Error(`no landed clips on track labelled ${label}`);
  }
  const sourceIds = [...new Set(clips.map((c) => c.source_id))];
  const projectDir = path.dirname(projectPath);
  let peak = 0;
  for (const sourceId of sourceIds) {
    const source = saved.sources.find((s) => s.id === sourceId);
    if (!source) {
      throw new Error(
        `clip on track ${label} references missing source ${sourceId}`,
      );
    }
    if (!/^raw\//.test(source.path)) {
      throw new Error(
        `source ${source.id} for track ${label} is not under raw/: ${source.path}`,
      );
    }
    const buf = await readFile(path.join(projectDir, source.path));
    peak = Math.max(peak, wavPeak(new Uint8Array(buf)));
  }
  return peak;
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

/** Open the host's Record room dialog from the app menu and wait for it. */
export async function openHostRecordRoom(host: Page): Promise<Locator> {
  await host.getByRole("button", { name: "Menu" }).click();
  await host.getByRole("menuitem", { name: "Record room…" }).click();
  const roomDlg = host.getByRole("dialog", { name: "Record room" });
  await expect(roomDlg).toBeVisible();
  return roomDlg;
}

/**
 * Wait for `name` to auto-land, or click Land if it becomes enabled first
 * (tolerating auto-land disabling it between the check and the click).
 */
export async function landParticipant(
  roomDlg: Locator,
  name: string,
): Promise<void> {
  const uploadList = roomDlg.getByRole("list", { name: "Upload status" });
  const landed = uploadList.getByText(`${name}: landed.`);
  const landButton = roomDlg.getByRole("button", {
    name: "Land",
    exact: true,
  });
  await expect
    .poll(
      async () => {
        if (await landed.isVisible()) return "landed";
        if ((await landButton.count()) > 0 && (await landButton.isEnabled())) {
          return "land";
        }
        return "waiting";
      },
      { timeout: 60_000 },
    )
    .not.toBe("waiting");
  if (!(await landed.isVisible())) {
    await landButton.click({ timeout: 5_000 }).catch(async (error: unknown) => {
      // Auto-land may disable Land between the check and the click.
      if (!(await landed.isVisible())) throw error;
    });
  }
  await expect(landed).toBeVisible({ timeout: 60_000 });
}
