import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page } from "@playwright/test";
import {
  acceptedEnvelopeCommand,
  addEnvelopePoint,
  type EnvelopeCommand,
  type EnvelopeSnapshot,
  emptyEnvelopeProject,
  envelopeSnapshot,
  envelopeTrack,
  observeEnvelopeCommands,
  openEnvelopePoint,
  openEnvelopeTrackDetails,
  setPointField,
  showEnvelope,
} from "./envelopeCreationEvidence";
import { type InteractionReceipt, test } from "./interactionEvidence";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
  type ReviewShareRole,
} from "./shareNavigation";

type GuestEnvelopeScene = {
  guest: Page;
  token: string;
  projectPath: string;
  track: ReturnType<typeof envelopeTrack>;
  accepted: Awaited<ReturnType<typeof acceptedEnvelopeCommand>>;
  baseline: EnvelopeSnapshot;
  requests: EnvelopeCommand[];
};

/**
 * The host saves one volume point, then a review link of `role` opens the
 * same track's envelope controls in a second context; `body` asserts what
 * that guest may do. Guest document commands are collected in `requests`.
 */
async function withGuestEnvelope(
  role: ReviewShareRole,
  {
    page,
    browser,
    receipts,
  }: {
    page: Page;
    browser: Browser;
    receipts: InteractionReceipt[];
  },
  body: (scene: GuestEnvelopeScene) => Promise<void>,
) {
  await withShareableProject(
    async (projectPath) => {
      const track = envelopeTrack(projectPath);
      await openHostShare(page, projectPath);
      await openEnvelopeTrackDetails(page, track.label, receipts);
      await showEnvelope(page);
      const accepted = await acceptedEnvelopeCommand(page, "SetEnvelope", () =>
        addEnvelopePoint(page),
      );
      const token = await createReviewShare(page, projectPath, role);
      const context = await browser.newContext({
        baseURL: new URL(page.url()).origin,
        viewport: { width: 1440, height: 900 },
      });
      let primary: unknown;
      try {
        const guest = await context.newPage();
        await openGuestShare(guest, token);
        const requests: EnvelopeCommand[] = [];
        guest.on("request", (request) => {
          if (
            request.method() === "POST" &&
            new URL(request.url()).pathname.endsWith("/daw/document/command")
          )
            requests.push(request.postDataJSON() as EnvelopeCommand);
        });
        const baseline = envelopeSnapshot(projectPath, track.id);
        const observer = observeEnvelopeCommands(
          page,
          projectPath,
          track.id,
          receipts,
        );
        try {
          // A Viewer share has no Edit stage, so there is no envelope GUI to open.
          if (role !== "viewer") {
            await openEnvelopeTrackDetails(guest, track.label, receipts);
            await showEnvelope(guest);
          }
          await body({
            guest,
            token,
            projectPath,
            track,
            accepted,
            baseline,
            requests,
          });
        } finally {
          await observer.retain();
        }
      } catch (error) {
        primary = error;
      } finally {
        try {
          await context.close();
        } catch (error) {
          if (primary === undefined) primary = error;
          receipts.push({
            checkpoint: "guest-cleanup-error",
            observation: { error: String(error) },
          });
        }
      }
      if (primary !== undefined) throw primary;
    },
    undefined,
    emptyEnvelopeProject,
  );
}

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

test("viewer share keeps envelope GUI read-only", async ({
  page,
  browser,
  receipts,
}) => {
  await withGuestEnvelope(
    "viewer",
    { page, browser, receipts },
    async ({
      guest,
      token,
      track,
      accepted,
      baseline,
      requests,
      projectPath,
    }) => {
      await expect(
        guest.getByRole("main", { name: "Review", exact: true }),
      ).toBeVisible();
      await expect(guest.getByRole("tab", { name: "Edit" })).toHaveCount(0);
      await expect(guest.locator(".lane-row")).toHaveCount(0);
      const before = null;
      expect(requests).toEqual([]);
      expect(envelopeSnapshot(projectPath, track.id)).toEqual(baseline);
      receipts.push({
        checkpoint: "viewer-read-only-native-GUI",
        observation: { accepted, baseline, before, requests },
      });
      const request = {
        type: "SetEnvelope",
        command_id: randomUUID(),
        client_id: `envelope-policy-${randomUUID()}`,
        client_seq: 1,
        payload: {
          track_id: track.id,
          expected_points: baseline.points,
          points: [],
        },
      };
      const response = await guest.request.post(
        `/api/review/${token}/daw/document/command`,
        { data: request },
      );
      const body: unknown = await response.json();
      expect(response.status()).toBe(403);
      expect(envelopeSnapshot(projectPath, track.id)).toEqual(baseline);
      receipts.push({
        checkpoint: "actual-viewer-server-refusal",
        observation: { request, status: response.status(), body },
      });
    },
  );
});

// Owner decision (#1051): Editor review links change volume envelopes as the
// host does; the server's Editor command set includes SetEnvelope.
test("editor share edits a volume envelope point", async ({
  page,
  browser,
  receipts,
}) => {
  await withGuestEnvelope(
    "editor",
    { page, browser, receipts },
    async ({ guest, track, accepted, baseline, requests, projectPath }) => {
      await openEnvelopePoint(guest, 1);
      await expect(
        guest.getByText(
          "This link can view, but not edit, the volume envelope.",
          { exact: true },
        ),
      ).toHaveCount(0);
      const pointId = accepted.command.payload.points![0]!.id;
      const saved = guest.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/daw/document/command"),
      );
      await setPointField(guest, "Level", "0.5");
      const response = await saved;
      expect(response.status()).toBe(200);
      expect(requests.map((command) => command.type)).toEqual(["SetEnvelope"]);
      const expected = baseline.points.map((point) =>
        point.id === pointId ? { ...point, value: 0.5 } : point,
      );
      await expect
        .poll(() => envelopeSnapshot(projectPath, track.id).points)
        .toEqual(expected);
      receipts.push({
        checkpoint: "editor-envelope-edit-accepted",
        observation: {
          accepted,
          baseline,
          requests,
          after: envelopeSnapshot(projectPath, track.id),
        },
      });
    },
  );
});
