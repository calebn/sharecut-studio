import { type BrowserContext, expect, type Route } from "@playwright/test";
import {
  acceptedEnvelopeCommand,
  addEnvelopePoint,
  type EnvelopeCommand,
  emptyEnvelopeProject,
  envelopeSnapshot,
  envelopeTrack,
  observeEnvelopeCommands,
  openEnvelopePoint,
  openEnvelopeTrackDetails,
  pointSheet,
  setPointField,
  showEnvelope,
} from "./envelopeCreationEvidence";
import { test } from "./interactionEvidence";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { trackHeaderButtons } from "./trackHeader";

const documentCommandURL = (url: URL) =>
  url.pathname === "/api/document/command";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
test("real ordered CAS refusal keeps the winning envelope and offers a reload", async ({
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
        await showEnvelope(page);
        await acceptedEnvelopeCommand(page, "SetEnvelope", () =>
          addEnvelopePoint(page),
        );
        peerContext = await browser.newContext({
          baseURL: new URL(page.url()).origin,
          viewport: { width: 1440, height: 900 },
        });
        const peer = await peerContext.newPage();
        await openHostShare(peer, projectPath);
        await openEnvelopeTrackDetails(peer, track.label, receipts);
        await showEnvelope(peer);
        await openEnvelopePoint(peer, 1);
        await openEnvelopePoint(page, 1);
        const localWinner = envelopeSnapshot(projectPath, track.id);
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
        await setPointField(page, "Level", "0.2");
        await expect
          .poll(() => held?.payload.expected_points)
          .toEqual(localWinner.points);
        await expect(
          pointSheet(page).getByRole("spinbutton", {
            name: "Level",
            exact: true,
          }),
        ).toHaveAttribute("aria-readonly", "true");
        const peerSecond = await acceptedEnvelopeCommand(
          peer,
          "SetEnvelope",
          () => setPointField(peer, "Level", "0.8"),
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
        await expect(pointSheet(page).getByRole("alert")).toBeVisible();
        expect(envelopeSnapshot(projectPath, track.id)).toEqual(winning);
        await pointSheet(page)
          .getByRole("button", { name: "Reload points", exact: true })
          .click();
        await expect(pointSheet(page).getByRole("alert")).toHaveCount(0);
        await expect(
          pointSheet(page).getByRole("spinbutton", {
            name: "Level",
            exact: true,
          }),
        ).toHaveAttribute("aria-valuenow", "0.8");
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
        await showEnvelope(page);
        await acceptedEnvelopeCommand(page, "SetEnvelope", () =>
          addEnvelopePoint(page),
        );
        await openEnvelopePoint(page, 1);
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
        await setPointField(page, "Level", "0.4");
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
          pointSheet(page).getByRole("spinbutton", {
            name: "Level",
            exact: true,
          }),
        ).toHaveAttribute("aria-readonly", "true");
        await expect
          .poll(() => envelopeSnapshot(projectPath, track.id).points)
          .toEqual(command!.payload.points);
        const label = (await trackHeaderButtons(page)
          .nth(1)
          .locator(".sys-track-name")
          .textContent())!;
        await openEnvelopeTrackDetails(page, label, receipts);
        await expect(
          page
            .getByRole("dialog", { name: "Inspector" })
            .getByRole("heading", { level: 2 })
            .first(),
        ).toHaveText(label);
        const responseDelivered = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/document/command" &&
            (response.request().postDataJSON() as EnvelopeCommand)
              .command_id === command?.command_id,
        );
        release();
        await responseDelivered;
        await expect(
          page
            .getByRole("dialog", { name: "Inspector" })
            .getByRole("heading", { level: 2 })
            .first(),
        ).toHaveText(label);
        expect(
          observer.commands.filter((item) => item.type === "SetEnvelope"),
        ).toHaveLength(2);
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
