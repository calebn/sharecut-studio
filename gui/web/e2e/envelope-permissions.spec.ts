import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import {
  acceptedEnvelopeCommand,
  emptyEnvelopeProject,
  envelopeSnapshot,
  envelopeTrack,
  observeEnvelopeCommands,
  openEnvelopeTrackDetails,
} from "./envelopeCreationEvidence";
import { test } from "./interactionEvidence";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
for (const role of ["viewer", "editor"] as const) {
  test(`${role} share keeps envelope GUI read-only`, async ({
    page,
    browser,
    receipts,
  }) => {
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
        const accepted = await acceptedEnvelopeCommand(
          page,
          "SetEnvelope",
          () =>
            page
              .getByRole("button", { name: "Save point", exact: true })
              .click(),
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
          const requests: unknown[] = [];
          guest.on("request", (request) => {
            if (
              request.method() === "POST" &&
              new URL(request.url()).pathname.endsWith("/daw/document/command")
            )
              requests.push(request.postDataJSON());
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
            await guest
              .getByRole("button", {
                name: "View volume envelope",
                exact: true,
              })
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
            await guest.mouse.move(
              box!.x + box!.width / 2,
              box!.y + box!.height / 2,
            );
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
              checkpoint: `${role}-read-only-native-GUI`,
              observation: { accepted, baseline, before, requests },
            });
            if (role === "viewer") {
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
            }
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
  });
}
