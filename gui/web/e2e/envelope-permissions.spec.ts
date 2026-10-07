import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page } from "@playwright/test";
import {
  acceptedEnvelopeCommand,
  type EnvelopeCommand,
  type EnvelopeSnapshot,
  emptyEnvelopeProject,
  envelopeSnapshot,
  envelopeTrack,
  observeEnvelopeCommands,
  openEnvelopeTrackDetails,
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
      await page
        .getByRole("button", { name: "Add volume envelope", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Add point", exact: true })
        .click();
      const accepted = await acceptedEnvelopeCommand(page, "SetEnvelope", () =>
        page.getByRole("button", { name: "Save point", exact: true }).click(),
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
          await openEnvelopeTrackDetails(guest, track.label, receipts);
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
      await guest
        .getByRole("button", { name: "View volume envelope", exact: true })
        .click();
      await expect(
        guest.getByText(
          "Volume envelope editing is available to the project owner.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        guest.getByRole("button", {
          name: /^(Add point|Edit point|Save point|Delete point|Remove volume envelope)$/,
        }),
      ).toHaveCount(0);
      await guest
        .getByRole("combobox", { name: "Envelope point", exact: true })
        .selectOption(accepted.command.payload.points![0]!.id);
      const owner = guest
        .locator(".lane-row")
        .first()
        .locator('circle[aria-label^="Envelope point 1 at"]');
      const before = await owner.evaluate((element) => ({
        x: element.getAttribute("cx"),
        y: element.getAttribute("cy"),
      }));
      const box = await owner.boundingBox();
      expect(box).not.toBeNull();
      await guest.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await guest.mouse.down();
      await guest.mouse.move(box!.x + 40, box!.y + 20);
      await guest.mouse.up();
      await owner.focus();
      await guest.keyboard.press("Enter");
      expect(
        await owner.evaluate((element) => ({
          x: element.getAttribute("cx"),
          y: element.getAttribute("cy"),
        })),
      ).toEqual(before);
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
      await guest
        .getByRole("button", { name: "Edit volume envelope", exact: true })
        .click();
      await expect(
        guest.getByText(
          "Volume envelope editing is available to the project owner.",
          { exact: true },
        ),
      ).toHaveCount(0);
      const pointId = accepted.command.payload.points![0]!.id;
      await guest
        .getByRole("combobox", { name: "Envelope point", exact: true })
        .selectOption(pointId);
      await guest
        .getByRole("button", { name: "Edit point", exact: true })
        .click();
      await guest.getByRole("textbox", { name: "Level (×)" }).fill("0.5");
      const saved = guest.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/daw/document/command"),
      );
      await guest
        .getByRole("button", { name: "Save point", exact: true })
        .click();
      const response = await saved;
      expect(response.status()).toBe(200);
      expect(requests.map((command) => command.type)).toEqual(["SetEnvelope"]);
      await expect
        .poll(() =>
          envelopeSnapshot(projectPath, track.id).points.map(
            (point) => point.value,
          ),
        )
        .toEqual([0.5]);
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
