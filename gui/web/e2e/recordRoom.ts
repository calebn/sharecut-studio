import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";

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
      source_id: string;
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
