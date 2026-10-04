import { type BrowserContext, expect, type Route } from "@playwright/test";
import {
  acceptedEnvelopeCommand,
  type EnvelopeCommand,
  emptyEnvelopeProject,
  envelopeSnapshot,
  envelopeTrack,
  observeEnvelopeCommands,
  openEnvelopeTrackDetails,
} from "./envelopeCreationEvidence";
import { test } from "./interactionEvidence";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";

const documentCommandURL = (url: URL) =>
  url.pathname === "/api/document/command";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
test("local stale draft and real ordered CAS refusal preserve the winning envelope", async ({
  page,
  browser,
  receipts,
}) => {
  await withShareableProject(
    async (projectPath) => {
      const track = envelopeTrack(projectPath);
      const observer = observeEnvelopeCommands(
        page,
        projectPath,
        track.id,
        receipts,
      );
      let peerContext: BrowserContext | undefined;
      let release = () => {};
      let primary: unknown;
      try {
        await openHostShare(page, projectPath);
        await openEnvelopeTrackDetails(page, track.label, receipts);
        await page
          .getByRole("button", { name: "Add volume envelope", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Add point", exact: true })
          .click();
        const first = await acceptedEnvelopeCommand(page, "SetEnvelope", () =>
          page.getByRole("button", { name: "Save point", exact: true }).click(),
        );
        const pointId = first.command.payload.points![0]!.id;
        peerContext = await browser.newContext({
          baseURL: new URL(page.url()).origin,
          viewport: { width: 1440, height: 900 },
        });
        const peer = await peerContext.newPage();
        await openHostShare(peer, projectPath);
        await openEnvelopeTrackDetails(peer, track.label, receipts);
        await peer
          .getByRole("button", { name: "Edit volume envelope", exact: true })
          .click();
        await peer
          .getByRole("combobox", { name: "Envelope point", exact: true })
          .selectOption(pointId);
        await page
          .getByRole("button", { name: "Edit point", exact: true })
          .click();
        await page.getByLabel("Level (×)").fill("0.2");
        observer.stage("local-stale-draft");
        await peer
          .getByRole("button", { name: "Edit point", exact: true })
          .click();
        await peer.getByLabel("Level (×)").fill("0.6");
        const peerFirst = await acceptedEnvelopeCommand(
          peer,
          "SetEnvelope",
          () =>
            peer
              .getByRole("button", { name: "Save point", exact: true })
              .click(),
        );
        await expect(
          page
            .getByRole("combobox", { name: "Envelope point", exact: true })
            .locator("option", { hasText: "0.6×" }),
        ).toHaveCount(1);
        const localCount = observer.commands.length;
        await page
          .getByRole("button", { name: "Save point", exact: true })
          .click();
        await expect(page.getByRole("alert")).toContainText(
          "changed since editing started",
        );
        expect(observer.commands).toHaveLength(localCount);
        await expect(page.getByLabel("Level (×)")).toHaveValue("0.2");
        const localWinner = envelopeSnapshot(projectPath, track.id);
        expect(localWinner.points).toEqual(peerFirst.command.payload.points);
        receipts.push({
          checkpoint: "local-stale-zero-request",
          observation: { peerFirst, localWinner, localCount },
        });
        await page
          .getByRole("button", {
            name: "Discard draft and reload points",
            exact: true,
          })
          .click();
        await page
          .getByRole("button", { name: "Edit point", exact: true })
          .click();
        await page.getByLabel("Level (×)").fill("0.2");
        let held: EnvelopeCommand | undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const hold = async (route: Route) => {
          const command = route.request().postDataJSON() as EnvelopeCommand;
          if (command.type !== "SetEnvelope") {
            await route.continue();
            return;
          }
          held = command;
          await gate;
          await route.continue();
        };
        await page.route(documentCommandURL, hold);
        observer.stage("held-real-server-CAS");
        await page
          .getByRole("button", { name: "Save point", exact: true })
          .click();
        await expect
          .poll(() => held?.payload.expected_points)
          .toEqual(localWinner.points);
        await expect(
          page.getByRole("button", { name: "Save point", exact: true }),
        ).toBeDisabled();
        await peer
          .getByRole("button", { name: "Edit point", exact: true })
          .click();
        await peer.getByLabel("Level (×)").fill("0.8");
        const peerSecond = await acceptedEnvelopeCommand(
          peer,
          "SetEnvelope",
          () =>
            peer
              .getByRole("button", { name: "Save point", exact: true })
              .click(),
        );
        await expect
          .poll(() => envelopeSnapshot(projectPath, track.id).points)
          .toEqual(peerSecond.command.payload.points);
        const winning = envelopeSnapshot(projectPath, track.id);
        const refusedResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/document/command" &&
            (response.request().postDataJSON() as EnvelopeCommand)
              .command_id === held?.command_id,
        );
        release();
        const refusal = await refusedResponse;
        const refusalBody: unknown = await refusal.json();
        expect(refusal.status()).toBe(409);
        expect(refusal.request().postDataJSON()).toEqual(held);
        expect(JSON.stringify(refusalBody)).toMatch(/changed|conflict/i);
        await expect(page.getByLabel("Level (×)")).toHaveValue("0.2");
        await expect(
          page.getByRole("button", {
            name: "Discard draft and reload points",
            exact: true,
          }),
        ).toBeVisible();
        expect(envelopeSnapshot(projectPath, track.id)).toEqual(winning);
        receipts.push({
          checkpoint: "actual-server-CAS-refusal",
          observation: {
            held: held!,
            peerSecond,
            winning,
            refusal: { status: refusal.status(), body: refusalBody },
          },
        });
        await page.unroute(documentCommandURL, hold);
      } catch (error) {
        primary = error;
      } finally {
        release();
        await observer.retain();
        try {
          await peerContext?.close();
        } catch (error) {
          if (primary === undefined) primary = error;
          receipts.push({
            checkpoint: "peer-cleanup-error",
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

test("accepted envelope save does not reclaim a different inspector while response delivery is pending", async ({
  page,
  receipts,
}) => {
  await withShareableProject(
    async (projectPath) => {
      const track = envelopeTrack(projectPath);
      const observer = observeEnvelopeCommands(
        page,
        projectPath,
        track.id,
        receipts,
      );
      let release = () => {};
      try {
        await openHostShare(page, projectPath);
        await openEnvelopeTrackDetails(page, track.label, receipts);
        await page
          .getByRole("button", { name: "Add volume envelope", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Add point", exact: true })
          .click();
        await page.getByLabel("Level (×)").fill("0.4");
        const origin = envelopeSnapshot(projectPath, track.id);
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let accepted: unknown;
        let command: EnvelopeCommand | undefined;
        await page.route(documentCommandURL, async (route) => {
          const sent = route.request().postDataJSON() as EnvelopeCommand;
          if (sent.type !== "SetEnvelope") {
            await route.continue();
            return;
          }
          command = sent;
          const response = await route.fetch();
          accepted = await response.json();
          await gate;
          await route.fulfill({ response });
        });
        observer.stage("accepted-pending-delivery");
        await page
          .getByRole("button", { name: "Save point", exact: true })
          .dblclick();
        await expect
          .poll(() => accepted)
          .toMatchObject({ ok: true, type: "Applied" });
        expect(accepted).toMatchObject({
          command: {
            command_id: command!.command_id,
            client_id: command!.client_id,
            client_seq: command!.client_seq,
            type: "SetEnvelope",
          },
        });
        await expect(
          page.getByRole("button", { name: "Save point", exact: true }),
        ).toBeDisabled();
        await expect
          .poll(() => envelopeSnapshot(projectPath, track.id).points)
          .toEqual(command!.payload.points);
        const otherTrack = page
          .getByRole("button", { name: /^Open track details,/ })
          .nth(1);
        const label = (await otherTrack.getAttribute("aria-label"))!.replace(
          "Open track details, ",
          "",
        );
        await openEnvelopeTrackDetails(page, label, receipts);
        await expect(page.locator(".modifier-inspector h2")).toHaveText(label);
        const responseDelivered = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/document/command" &&
            (response.request().postDataJSON() as EnvelopeCommand)
              .command_id === command?.command_id,
        );
        release();
        await responseDelivered;
        await expect(page.locator(".modifier-inspector h2")).toHaveText(label);
        expect(
          observer.commands.filter((item) => item.type === "SetEnvelope"),
        ).toHaveLength(1);
        receipts.push({
          checkpoint: "accepted-command-survives-view-departure",
          observation: {
            origin,
            command: command!,
            accepted,
            saved: envelopeSnapshot(projectPath, track.id),
            inspector: label,
          },
        });
      } finally {
        release();
        await observer.retain();
      }
    },
    undefined,
    emptyEnvelopeProject,
  );
});
