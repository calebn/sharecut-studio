import { expect, type Locator } from "@playwright/test";
import {
  acceptedEnvelopeCommand,
  addEnvelopePoint,
  dismissToast,
  emptyEnvelopeProject,
  envelopeSnapshot,
  envelopeTrack,
  inspectEnvelopePoint,
  openEnvelopeTrackDetails,
  pointSheet,
  setPointField,
  showEnvelope,
} from "../e2e/envelopeCreationEvidence";
import {
  controlGeometry,
  wheelInspector,
} from "../e2e/inspectorResponsiveEvidence";
import { test } from "../e2e/interactionEvidence";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";
import { openProject } from "../e2e/stageNav";

test.use({
  viewport: { width: 568, height: 320 },
});

test("568x320 phone envelope controls scroll into reach and preserve saved points", async ({
  page,
  receipts,
}) => {
  await withShareableProject(
    async (projectPath) => {
      const track = envelopeTrack(projectPath);
      await openProject(page, projectPath);
      await expect(page.locator(".stage-frame--phone")).toBeVisible();
      await openPhoneTimeline(page);
      await openEnvelopeTrackDetails(page, track.label, receipts);
      await showEnvelope(page);
      const trackInspector = page.getByRole("dialog", { name: "Inspector" });
      await expect(trackInspector).toBeVisible();
      await trackInspector.getByRole("button", { name: "Close" }).click();
      await expect(trackInspector).toBeHidden();

      const lane = page.locator(`.lane-row[data-track-id="${track.id}"]`);
      await expect(lane).toBeVisible();
      const laneBox = await lane.boundingBox();
      expect(laneBox).not.toBeNull();
      const viewportWidth = page.viewportSize()!.width;
      const laneLeft = Math.max(laneBox!.x, 0);
      const laneRight = Math.min(laneBox!.x + laneBox!.width, viewportWidth);
      const lanePoint = {
        x: laneLeft + (laneRight - laneLeft) * 0.5,
        y: laneBox!.y + laneBox!.height / 2,
      };
      const laneHit = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        const hitLane = hit?.closest<HTMLElement>(".lane-row");
        return {
          insideViewport: x > 0 && x < innerWidth && y > 0 && y < innerHeight,
          trackId: hitLane?.dataset.trackId ?? null,
          hit: hit
            ? { tag: hit.tagName, className: hit.getAttribute("class") }
            : null,
        };
      }, lanePoint);
      receipts.push({
        checkpoint: "envelope-create-lane-context-admission",
        observation: { ...laneHit, expectedTrackId: track.id },
      });
      expect(laneHit.insideViewport).toBe(true);
      expect(laneHit.trackId).toBe(track.id);
      const added = await acceptedEnvelopeCommand(page, "SetEnvelope", () =>
        addEnvelopePoint(page, { trackId: track.id, share: 0.5 }),
      );
      expect(added.command.payload.expected_points).toEqual([]);
      const created = added.command.payload.points ?? [];
      expect(created.length).toBeGreaterThan(0);
      await expect
        .poll(() => envelopeSnapshot(projectPath, track.id).points)
        .toEqual(created);
      await inspectEnvelopePoint(page);
      const points = page.getByRole("slider", { name: /^Envelope point / });
      await expect(points).toHaveCount(created.length);
      const selectedTime = Number(
        await pointSheet(page)
          .getByRole("spinbutton", { name: "Time", exact: true })
          .getAttribute("aria-valuenow"),
      );
      expect(Number.isFinite(selectedTime)).toBe(true);
      const selectedMatches = created.filter(
        (point) => point.time === selectedTime,
      );
      expect(selectedMatches).toHaveLength(1);
      const selectedPoint = selectedMatches[0]!;
      expect(selectedPoint.value).toBe(1);

      const body = page.locator(".sys-inspector-scroll");
      await expect(body).toHaveCount(1);
      await expect(
        page.locator(".bottom-sheet-body, .sys-inspector-scroll"),
      ).toHaveCount(1);
      await expect(body).toBeVisible();
      const initialBody = await body.evaluate((element) => ({
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      expect(initialBody.scrollHeight).toBeGreaterThan(
        initialBody.clientHeight,
      );

      let observedProgress = false;
      let clippedToReachable = false;
      const reach = async (control: Locator) => {
        let geometry = await controlGeometry(control);
        const fullyAdmitted = () => {
          const measured = geometry.measured[0];
          return (
            geometry.measured.every(
              (item) => item.admission.state === "admitted",
            ) &&
            geometry.fullyVisible &&
            geometry.hitsControl &&
            measured.rect.left >= measured.clip.left - 1 &&
            measured.rect.right <= measured.clip.right + 1 &&
            measured.rect.top >= measured.clip.top - 1 &&
            measured.rect.bottom <= measured.clip.bottom + 1
          );
        };
        const wasClipped = !fullyAdmitted();
        let movedTowardReach = false;
        for (let attempt = 0; !fullyAdmitted() && attempt < 12; attempt++) {
          expect(
            geometry.measured.every(
              (item) => item.admission.state === "admitted",
            ),
            JSON.stringify(geometry),
          ).toBe(true);
          const before = await body.evaluate((element) => element.scrollTop);
          const target = geometry.measured[0];
          const delta = target.rect.top < target.clip.top ? -160 : 160;
          await wheelInspector(page, receipts, delta);
          if (delta < 0)
            await expect
              .poll(() => body.evaluate((element) => element.scrollTop))
              .toBeLessThan(before);
          else
            await expect
              .poll(() => body.evaluate((element) => element.scrollTop))
              .toBeGreaterThan(before);
          observedProgress = true;
          movedTowardReach = true;
          geometry = await controlGeometry(control);
        }
        expect(fullyAdmitted(), JSON.stringify(geometry)).toBe(true);
        expect(geometry.hitsControl, JSON.stringify(geometry)).toBe(true);
        if (wasClipped && movedTowardReach) clippedToReachable = true;
        receipts.push({
          checkpoint: "envelope-control-reached-after-body-wheel",
          observation: { wasClipped, movedTowardReach, geometry },
        });
        return geometry;
      };

      const dialog = pointSheet(page);
      const time = dialog.getByRole("spinbutton", {
        name: "Time",
        exact: true,
      });
      await reach(time);

      const level = dialog.getByRole("spinbutton", {
        name: "Level",
        exact: true,
      });
      await reach(level);
      await setPointField(page, "Level", "0.75");
      await expect(level).toHaveAttribute("aria-valuenow", "0.75");
      const expectedEdited = created.map((point) =>
        point.id === selectedPoint!.id ? { ...point, value: 0.75 } : point,
      );
      await expect
        .poll(() => envelopeSnapshot(projectPath, track.id).points)
        .toEqual(expectedEdited);
      expect(envelopeSnapshot(projectPath, track.id).points).toEqual(
        expectedEdited,
      );
      await dismissToast(page, "Envelope point changed");

      const remove = dialog.getByRole("button", { name: /^Remove/ });
      const removeGeometry = await reach(remove);
      await page.mouse.click(removeGeometry.point.x, removeGeometry.point.y);
      const expectedRemoved = expectedEdited.filter(
        (point) => point.id !== selectedPoint!.id,
      );
      await expect
        .poll(() => envelopeSnapshot(projectPath, track.id).points)
        .toEqual(expectedRemoved);
      expect(envelopeSnapshot(projectPath, track.id).points).toEqual(
        expectedRemoved,
      );
      expect(
        observedProgress,
        "ordinary wheel input moves the Inspector body",
      ).toBe(true);
      expect(
        clippedToReachable,
        "a clipped control becomes reachable after observed body scrolling",
      ).toBe(true);
    },
    undefined,
    emptyEnvelopeProject,
  );
});
