import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "../e2e/axe";
import { bouncedWavs } from "../e2e/exportFiles";
import { keeperContextSource, RECORDER_CONTEXT } from "../e2e/keeperContexts";
import { keeperWavBytes, ONE_SECOND_KEEPER_WAV_BYTES } from "../e2e/keeperOpfs";
import { expectPlaybackAdvancesThenHolds, playButton } from "../e2e/playback";
import {
  clickHostTransport,
  closeHostMore,
  createRecordRoom,
  HOST_PARTICIPANT_ID,
  joinAsGuest,
  landedTrackPeakOrPending,
  landParticipant,
  markSharecutE2e,
  openHostRecordRoom,
  recordParticipantId,
  roomPill,
  stopHostTake,
  waitForSegmentsAcked,
} from "../e2e/recordRoom";
import { withShareableProject } from "../e2e/shareableProject";
import { createReviewShare, openGuestShare } from "../e2e/shareNavigation";
import {
  deliverPage,
  goToStage,
  openPanel,
  waitForLanding,
} from "../e2e/stageNav";
import { ownsStudioAxe } from "../e2e/studioAxeOwnership";
import {
  openTranscriptPanel,
  withDocumentCommandTypes,
} from "../e2e/transcriptEdit";
import { withBrowserPages } from "../e2e/twoBrowserPages";
import { wavPeak } from "../e2e/wavPeak";
import { AUTO_MIX_PREF_KEY } from "../src/hooks/autoMixPref";

/**
 * Landed and bounced audio must carry signal, not silence (−40 dBFS). The
 * measured Chromium peaks are in the PR that added this spec; never lower it
 * to let silence pass.
 */
const AUDIBLE_PEAK = 0.01;

/**
 * One serial walk on purpose: the export stage bounces a mix that includes the
 * track the record stage landed, and this same walk also runs on WebKit
 * (`playwright.compat.config.ts`'s `webkit` project, #704), through
 * `keeperContextSource`. The cost: with `retries: 0`, a failing stage stops
 * the later ones, so a record-stage failure hides share and Bounce results
 * until it is fixed. The report names the failing `test.step`.
 */
test.describe("core flow", () => {
  test("records, transcribes, tightens, edits, shares and exports", async ({
    browser,
    browserName,
  }) => {
    test.slow();
    await withShareableProject(async (projectPath) => {
      // Host and guest record, so both need `RECORDER_CONTEXT`'s microphone
      // grant; on WebKit, `keeperContextSource` also swaps in the persistent
      // context each page needs for keeper OPFS capture (#704). The reviewer
      // only opens a review share afterward and needs neither.
      await withBrowserPages(
        keeperContextSource(browser),
        [RECORDER_CONTEXT, RECORDER_CONTEXT, {}],
        async (pages) => {
          const [host, guest, reviewer] = pages;
          expect(host).toBeTruthy();
          expect(guest).toBeTruthy();
          expect(reviewer).toBeTruthy();
          if (!host || !guest || !reviewer) return;

          await test.step("record: keeper capture, upload and landing", async () => {
            await host.addInitScript((key) => {
              window.localStorage.setItem(key, "off");
            }, AUTO_MIX_PREF_KEY);
            await markSharecutE2e(host);
            await host.goto(
              `/?project=${encodeURIComponent(projectPath)}&e2e=1`,
            );
            await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
            // The landing stage is picked once the project has loaded; a stage
            // chosen earlier gets overruled.
            await waitForLanding(host);

            const room = await createRecordRoom(host, projectPath);
            const roomDlg = await openHostRecordRoom(host);

            await markSharecutE2e(guest);
            await joinAsGuest(guest, room.guest.token, "Ava");

            const start = roomDlg.getByRole("button", {
              name: "Record",
              exact: true,
            });
            await expect(start).toBeEnabled();
            await clickHostTransport(
              host,
              start,
              projectPath,
              "Start",
              "recording",
            );
            await expect(roomPill(guest)).toHaveText(/^\d+:\d{2} · Take \d+$/);

            await expect
              .poll(() => keeperWavBytes(guest), { timeout: 30_000 })
              .toBeGreaterThan(ONE_SECOND_KEEPER_WAV_BYTES);

            await stopHostTake(host, roomDlg, projectPath);
            await expect(roomPill(guest)).toHaveText(/^(Saving · |Saved$)/);

            const guestId = await recordParticipantId(host, projectPath, "Ava");
            await waitForSegmentsAcked(host, projectPath, [
              guestId,
              HOST_PARTICIPANT_ID,
            ]);

            await landParticipant(roomDlg, "Ava");
            await closeHostMore(host);
            await expect(roomPill(guest)).toHaveText("Saved", {
              timeout: 30_000,
            });

            // Landing commits the project (ProjectWorkspace.mutate, atomic
            // save_project) before mark_landed drives the landed UI, but no test
            // pins that order. The poll absorbs only a not-yet-landed read and
            // fails fast on any other landedTrackPeak error.
            await expect
              .poll(() => landedTrackPeakOrPending(projectPath, "Ava"), {
                timeout: 15_000,
              })
              .toBeGreaterThan(AUDIBLE_PEAK);

            // The landed track lives on the Edit stage; Record shows the take.
            await goToStage(host, "edit");
            await expect(
              host.getByRole("button", { name: "Open track details, Ava" }),
            ).toBeVisible();
          });

          await test.step("transcribe: the episode transcript hydrates", async () => {
            // Live ASR is server-side (make e2e-slow); this checks the browser
            // renders the episode transcript.
            const list = await openTranscriptPanel(host);
            await expect(
              list.getByRole("button", { name: "my", exact: true }).first(),
            ).toBeVisible();
          });

          await test.step("review: the queue opens on its empty state", async () => {
            await openPanel(host, "queue");
            await expect(host.getByText("Nothing to decide")).toBeVisible();
          });

          await test.step("edit: correct a transcript word, then undo it", async () => {
            const list = await openTranscriptPanel(host);
            await withDocumentCommandTypes(host, async (types) => {
              await list
                .getByRole("button", { name: "my", exact: true })
                .first()
                .dblclick();
              const input = list.getByRole("textbox", { name: /Correct word/ });
              await expect(input).toBeFocused();
              await input.fill("My");
              await input.press("Enter");
              await expect(
                list.getByRole("button", { name: "My", exact: true }).first(),
              ).toBeVisible();
              await expect.poll(() => types).toContain("CorrectTranscriptWord");

              await host.keyboard.press("ControlOrMeta+Z");
              await expect(
                list.getByRole("button", { name: "my", exact: true }).first(),
              ).toBeVisible();
              await expect(
                list.getByRole("button", { name: "My", exact: true }),
              ).toHaveCount(0);
            });
            // The project is disposable; no API undo is needed here (unlike
            // transcript-inline-edit.spec.ts, which runs against the shared
            // live E2E project).
          });

          await test.step("share: a viewer plays the per-track MP3 proxies", async () => {
            await host.keyboard.press("ControlOrMeta+b");
            // The mix state is a row of the Deliver stage's readiness list.
            await goToStage(host, "deliver");
            await expect(
              host.getByText("Mix up to date", { exact: true }),
            ).toBeVisible({ timeout: 60_000 });
            const token = await createReviewShare(host, projectPath);
            const chunkPrefix = `/api/review/${token}/daw/proxy/`;
            const isChunk = (url: string) => {
              const p = new URL(url).pathname;
              return p.startsWith(chunkPrefix) && !p.endsWith("/manifest");
            };

            await openGuestShare(reviewer, token);
            await expect(playButton(reviewer)).toBeEnabled();

            // ProxyEngine fetches chunks only on play, so a 200 chunk proves
            // playback went through the proxy/decodeAudioData path — it could
            // not have come from the 0.25s silent premix withShareableProject
            // writes.
            const firstChunk = reviewer.waitForResponse((r) =>
              isChunk(r.url()),
            );
            await expectPlaybackAdvancesThenHolds(reviewer);
            const chunk = await firstChunk;
            expect(chunk.status()).toBe(200);
            expect(chunk.headers()["content-type"]).toMatch(/audio\/mpeg/);
          });

          await test.step("export: bounce the mix to a non-silent WAV", async () => {
            await goToStage(host, "deliver");
            const deliver = deliverPage(host);
            await expect(
              deliver.getByRole("heading", { name: "Bounce" }),
            ).toBeVisible();
            if (ownsStudioAxe({ suite: "compat", engine: browserName })) {
              await expectPageAxeClean(host);
            }
            await deliver
              .getByRole("button", { name: "Bounce", exact: true })
              .click();
            await expect(
              deliver.getByText("Bounced", { exact: true }),
            ).toBeVisible({ timeout: 60_000 });
            await expect(
              host
                .getByRole("status")
                .filter({ hasText: "Bounced 1 file(s) to export/bounces/" }),
            ).toHaveCount(1);

            await expect.poll(() => bouncedWavs(projectPath)).toHaveLength(1);
            const wavs = await bouncedWavs(projectPath);
            const bounced = wavs[0];
            expect(bounced).toBeTruthy();
            if (!bounced) return;
            expect(
              wavPeak(new Uint8Array(await readFile(bounced))),
            ).toBeGreaterThan(AUDIBLE_PEAK);
          });
        },
      );
    });
  });
});
