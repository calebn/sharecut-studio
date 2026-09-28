import { access } from "node:fs/promises";
import path from "node:path";
import { type Browser, expect, test } from "@playwright/test";
import {
  HOST_OFFLINE_COPY,
  hostReconnectPauseCopy,
  REC_CHIP_OFFLINE_LABEL,
  RECORD_ROOM_RECONNECTING_COPY,
  UPLOAD_DONE_COPY,
} from "../src/record/types";
import { recordApiBase } from "../src/shareRoute";
import {
  type KeeperRef,
  keeperSegmentIndexes,
  keeperSegmentWavBytes,
  ONE_SECOND_KEEPER_PCM_BYTES,
  ONE_SECOND_KEEPER_WAV_BYTES,
} from "./keeperOpfs";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import { installNetworkOutage, type NetworkOutage } from "./networkOutage";
import {
  clickHostTransport,
  createRecordRoom,
  currentTake,
  expectRemintRefused,
  HOST_PARTICIPANT_ID,
  hostRecordConnected,
  hostRecordSnapshot,
  joinAsGuest,
  landParticipant,
  markSharecutE2e,
  openHostRecordRoom,
  readSavedProject,
  recordParticipantId,
  waitForSegmentsAcked,
} from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { withBrowserPages } from "./twoBrowserPages";

/** services/record/state.py HOST_OFFLINE_PAUSE_MS: a host return after this long forces PAUSED. */
const HOST_OFFLINE_PAUSE_MS = 10_000;
/** Well inside the threshold, leaving room for the 1 s client reconnect timers. */
const HOST_BLIP_MS = 3_000;
/** Past the threshold with margin for a loaded runner. */
const HOST_OUTAGE_MS = 12_500;

type Outages = { host: NetworkOutage; guest: NetworkOutage };

/** A host outage also cuts the guest's tunnel: drop both together. */
async function dropBoth(outages: Outages): Promise<void> {
  await Promise.all([outages.host.drop(), outages.guest.drop()]);
}

function restoreBoth(outages: Outages): void {
  outages.host.restore();
  outages.guest.restore();
}

test.use({
  launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] },
});

test.describe("record host reconnect", () => {
  test("recording survives host disconnects (US-2)", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(browser, [{}, {}], async ([host, guest]) => {
        const project = encodeURIComponent(projectPath);

        // Install before host.goto: routes only apply to sockets opened after.
        await markSharecutE2e(host);
        const hostNet = await installNetworkOutage(host, {
          webSocket: /\/api\/session\/ws/,
        });

        let room!: Awaited<ReturnType<typeof createRecordRoom>>;
        let roomDlg!: Awaited<ReturnType<typeof openHostRecordRoom>>;
        let guestNet!: NetworkOutage;
        let guestId = "";
        let hostKeeper!: KeeperRef;
        let guestKeeper!: KeeperRef;
        const guestUploads: string[] = [];

        await test.step("setup: start REC with one guest", async () => {
          await host.goto(`/?project=${project}&e2e=1`);
          await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
          room = await createRecordRoom(host, projectPath);
          roomDlg = await openHostRecordRoom(host);

          await markSharecutE2e(guest);
          // The host tunnel carries the guest's record plane too: cut its
          // socket and its `/api/rec/` HTTP together with the host's.
          guestNet = await installNetworkOutage(guest, {
            webSocket: /\/api\/rec\/[^/]+\/ws/,
            http: (url) => url.pathname.startsWith("/api/rec/"),
          });
          guest.on("request", (req) => {
            const url = new URL(req.url());
            if (
              req.method() === "POST" &&
              url.pathname.endsWith("/upload") &&
              url.searchParams.get("kind") !== "room_tone"
            ) {
              guestUploads.push(url.pathname);
            }
          });

          await joinAsGuest(guest, room.guest.token, "Ava");
          guestId = await recordParticipantId(host, projectPath, "Ava");
          hostKeeper = {
            sessionId: room.session_id,
            takeIndex: 0,
            participantId: HOST_PARTICIPANT_ID,
          };
          guestKeeper = {
            sessionId: room.session_id,
            takeIndex: 0,
            participantId: guestId,
          };

          await clickHostTransport(
            host,
            roomDlg.getByRole("button", { name: "Start", exact: true }),
            projectPath,
            "Start",
            "recording",
          );
          await expect(guest.locator(".record-rec-label")).toHaveText("REC");

          for (const [page, keeper] of [
            [host, hostKeeper],
            [guest, guestKeeper],
          ] as const) {
            await expect
              .poll(() => keeperSegmentWavBytes(page, keeper, 0), {
                timeout: 30_000,
              })
              .toBeGreaterThan(ONE_SECOND_KEEPER_WAV_BYTES);
          }
        });

        const outages: Outages = { host: hostNet, guest: guestNet };

        await test.step("host blip under 10s stays REC, no remount", async () => {
          const blipAt = Date.now();
          await dropBoth(outages);
          // Proves the server saw the host leave, not just that the client thinks so.
          await expect
            .poll(() => hostRecordConnected(host, projectPath), {
              timeout: 5_000,
            })
            .toBe(false);

          await host.waitForTimeout(HOST_BLIP_MS);
          restoreBoth(outages);

          await expect
            .poll(() => hostRecordConnected(host, projectPath), {
              timeout: 5_000,
            })
            .toBe(true);
          // A slow reconnect should fail here with a clear message, not as an
          // odd forced pause further down.
          expect(Date.now() - blipAt).toBeLessThan(
            HOST_OFFLINE_PAUSE_MS - 1_000,
          );

          const snap = await hostRecordSnapshot(host, projectPath);
          expect(snap.state).toBe("recording");
          expect(snap.pause_reason ?? null).toBeNull();
          expect(currentTake(snap).pauses).toEqual([]);

          await expect(
            roomDlg.getByText(RECORD_ROOM_RECONNECTING_COPY),
          ).toBeHidden();
          await expect(guest.getByText(HOST_OFFLINE_COPY)).toBeHidden();
          await expect(guest.locator(".record-rec-label")).toHaveText("REC");

          const beforeHost = await keeperSegmentWavBytes(host, hostKeeper, 0);
          const beforeGuest = await keeperSegmentWavBytes(
            guest,
            guestKeeper,
            0,
          );
          expect(beforeHost).toBeGreaterThan(0);
          expect(beforeGuest).toBeGreaterThan(0);
          await expect
            .poll(() => keeperSegmentWavBytes(host, hostKeeper, 0), {
              timeout: 10_000,
            })
            .toBeGreaterThan(beforeHost + ONE_SECOND_KEEPER_PCM_BYTES / 2);
          await expect
            .poll(() => keeperSegmentWavBytes(guest, guestKeeper, 0), {
              timeout: 10_000,
            })
            .toBeGreaterThan(beforeGuest + ONE_SECOND_KEEPER_PCM_BYTES / 2);

          // Still growing, and still one segment each: no remount on a blip.
          expect(await keeperSegmentIndexes(host, hostKeeper)).toEqual([0]);
          expect(await keeperSegmentIndexes(guest, guestKeeper)).toEqual([0]);
        });

        await test.step("host outage of 10s+: guest offline copy, remint refused, keeper keeps growing", async () => {
          const outageAt = Date.now();
          await dropBoth(outages);

          await expect(guest.getByText(HOST_OFFLINE_COPY)).toBeVisible();
          await expect(guest.locator(".record-rec-label")).toHaveText("REC");

          await expect(
            roomDlg.getByText(RECORD_ROOM_RECONNECTING_COPY),
          ).toBeVisible();
          await expect(
            host.getByRole("button", { name: REC_CHIP_OFFLINE_LABEL }),
          ).toBeVisible();

          await expect
            .poll(
              async () =>
                (await hostRecordSnapshot(host, projectPath))
                  .host_offline_since_wall_ms ?? null,
            )
            .not.toBeNull();

          await expectRemintRefused(host, projectPath);

          const offline = await keeperSegmentWavBytes(guest, guestKeeper, 0);
          expect(offline).toBeGreaterThan(0);
          await expect
            .poll(() => keeperSegmentWavBytes(guest, guestKeeper, 0), {
              timeout: 8_000,
            })
            .toBeGreaterThan(offline + ONE_SECOND_KEEPER_PCM_BYTES);
          // The growth above happened while still offline.
          await expect(guest.getByText(HOST_OFFLINE_COPY)).toBeVisible();

          await host.waitForTimeout(
            Math.max(0, outageAt + HOST_OUTAGE_MS - Date.now()),
          );
          // Proves the guest's own upload/state polling hit the outage.
          expect(guestNet.blockedHttp).toBeGreaterThan(0);
          restoreBoth(outages);
        });

        await test.step("host return forces PAUSED; Resume returns to REC", async () => {
          await expect
            .poll(
              async () => (await hostRecordSnapshot(host, projectPath)).state,
              { timeout: 10_000 },
            )
            .toBe("paused");
          const paused = await hostRecordSnapshot(host, projectPath);
          expect(paused.pause_reason).toBe("host_reconnect");
          expect(paused.host_offline_gap_ms ?? 0).toBeGreaterThanOrEqual(
            HOST_OFFLINE_PAUSE_MS,
          );
          const pauses = currentTake(paused).pauses;
          expect(pauses).toHaveLength(1);
          expect(pauses[0]).toMatchObject({
            pause_reason: "host_reconnect",
            resume_wall_ms: null,
          });

          await expect(
            roomDlg.getByText(
              hostReconnectPauseCopy(paused.host_offline_gap_ms!),
            ),
          ).toBeVisible();
          await expect(
            roomDlg.getByText(RECORD_ROOM_RECONNECTING_COPY),
          ).toBeHidden();

          await expect(guest.locator(".record-rec-label")).toHaveText("PAUSED");
          await expect(guest.getByText(HOST_OFFLINE_COPY)).toBeHidden();
          // Host-only reconnect-pause copy must not leak to the guest.
          await expect(guest.getByText(/the host was offline/)).toHaveCount(0);

          await expectRemintRefused(host, projectPath);

          await clickHostTransport(
            host,
            roomDlg.getByRole("button", { name: "Resume", exact: true }),
            projectPath,
            "Resume",
            "recording",
          );
          await expect(guest.locator(".record-rec-label")).toHaveText("REC");
          await expect(
            roomDlg.getByText(/Paused: the host was offline/),
          ).toBeHidden();

          const resumed = await hostRecordSnapshot(host, projectPath);
          expect(resumed.pause_reason ?? null).toBeNull();
          expect(currentTake(resumed).pauses[0]?.resume_wall_ms).not.toBeNull();

          // Resume opens a new segment on every keeper; the host keeper also
          // remounts on the host-reconnect pause generation. A zero-sample
          // segment never uploads, so wait for real audio in the new one.
          for (const [page, keeper] of [
            [host, hostKeeper],
            [guest, guestKeeper],
          ] as const) {
            await expect
              .poll(
                async () => (await keeperSegmentIndexes(page, keeper)).length,
                { timeout: 15_000 },
              )
              .toBeGreaterThanOrEqual(2);
            const indexes = await keeperSegmentIndexes(page, keeper);
            const last = Math.max(...indexes);
            await expect
              .poll(() => keeperSegmentWavBytes(page, keeper, last), {
                timeout: 15_000,
              })
              .toBeGreaterThan(ONE_SECOND_KEEPER_WAV_BYTES);
          }
        });

        await test.step("stop, upload resumes on the same token, land", async () => {
          await clickHostTransport(
            host,
            roomDlg.getByRole("button", { name: "Stop", exact: true }),
            projectPath,
            "Stop",
            "stopped",
          );
          await expect(guest.locator(".record-rec-label")).toHaveText(
            "Stopped",
          );

          await waitForSegmentsAcked(host, projectPath, [
            guestId,
            HOST_PARTICIPANT_ID,
          ]);

          expect(guestUploads.length).toBeGreaterThan(0);
          const expectedUploadPath = `${recordApiBase(room.guest.token)}/upload`;
          for (const uploadPath of guestUploads) {
            expect(uploadPath).toBe(expectedUploadPath);
          }

          await landParticipant(roomDlg, "Ava");
          await expect(guest.getByText(UPLOAD_DONE_COPY)).toBeVisible({
            timeout: 30_000,
          });

          // Host keeper source ids are rec-<session>-<take>-<participant>-<segment>.
          const hostSourcePrefix = `rec-${room.session_id}-0-${HOST_PARTICIPANT_ID}-`;
          await expect
            .poll(
              async () =>
                (await readSavedProject(projectPath)).timeline.clips.filter(
                  (c) => c.source_id?.startsWith(hostSourcePrefix) ?? false,
                ).length,
              { timeout: 30_000 },
            )
            .toBeGreaterThanOrEqual(2);

          const saved = await readSavedProject(projectPath);
          const ava = saved.timeline.tracks.find((t) => t.label === "Ava");
          expect(ava, "landed track for Ava").toBeTruthy();
          const avaClips = saved.timeline.clips.filter(
            (c) => c.track_id === ava?.id,
          );
          // One clip per keeper segment across the pause: at least 2.
          expect(avaClips.length).toBeGreaterThanOrEqual(2);
          const hostClips = saved.timeline.clips.filter(
            (c) => c.source_id?.startsWith(hostSourcePrefix) ?? false,
          );
          expect(hostClips.length).toBeGreaterThanOrEqual(2);

          for (const clip of [...avaClips, ...hostClips]) {
            const source = saved.sources.find(
              (src) => src.id === clip.source_id,
            );
            expect(source, `source ${clip.source_id}`).toBeTruthy();
            expect(source?.path).toMatch(/^raw\//);
            await access(
              path.join(path.dirname(projectPath), source?.path ?? ""),
            );
          }

          // Auto-land's drift result is only logged, not returned to the
          // browser (a later /api/record/land has no pending segments left
          // to measure), so the land drift report after a host-reconnect
          // pause is asserted in
          // tests/test_record_host_reconnect.py::test_land_after_host_reconnect_pause_reports_drift.
        });
      });
    });
  });
});
