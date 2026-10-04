import { expect, test } from "@playwright/test";
import {
  armNativeProgress,
  retainNativeProgress,
} from "./nativeProgressObserver";

async function retainConformance(
  observation: Awaited<ReturnType<typeof armNativeProgress>>,
  primaryFailure: unknown,
) {
  await retainNativeProgress(
    primaryFailure,
    observation.finish,
    async (evidence) => {
      await test.info().attach("collector-conformance-evidence", {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      });
      if (primaryFailure === undefined)
        expect(evidence.cleanupFailures).toEqual([]);
    },
    (error) =>
      test.info().annotations.push({
        type: "secondary-retention-failure",
        description: String(error),
      }),
  );
}

test("passive native collector retains network and between-frame DOM evidence", async ({
  page,
}) => {
  await page.goto("/api/health");
  await page.setContent('<div class="pipeline-panel"></div>');
  const job = {
    id: "collector-conformance",
    kind: "pipeline",
    status: "running",
    current: 0,
    total: 2,
    steps: [],
  };
  await page.route(
    "**/api/pipeline/events?job_id=collector-conformance",
    (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "status", job })}\n\n`,
      }),
  );
  const observation = await armNativeProgress(page);
  let failure: unknown;
  try {
    expect(observation.available).toBe(true);
    observation.core.bind(job, performance.now());
    await page.evaluate(() => {
      const stream = new EventSource(
        "/api/pipeline/events?job_id=collector-conformance",
      );
      stream.onmessage = () => {
        const bar = document.createElement("div");
        bar.className = "pipeline-bar";
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-valuenow", "0");
        bar.style.width = "100px";
        bar.style.height = "8px";
        bar.innerHTML =
          '<div class="pipeline-bar-fill" style="width: 0px; height: 8px"></div>';
        document.querySelector(".pipeline-panel")!.append(bar);
        bar.setAttribute("aria-valuenow", "50");
        bar.setAttribute("aria-valuenow", "100");
        (bar.querySelector(".pipeline-bar-fill") as HTMLElement).style.width =
          "100px";
        stream.close();
      };
    });
    await expect
      .poll(
        () =>
          observation.core.inputs.records.filter(
            (input) => input.source === "sse-network",
          ).length,
      )
      .toBe(1);
    await expect(
      page.locator('.pipeline-bar[role="progressbar"]'),
    ).toHaveAttribute("aria-valuenow", "100");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const evidence = await observation.finish();
    expect(evidence.issues).toEqual([]);
    expect(evidence.observationIntegrity).toBe(
      "complete-within-observer-window",
    );
    expect(evidence.relations.zeroSources).toContain("sse-network");
    expect(evidence.relations.zeroDomMutationObserved).toBe(true);
    expect(evidence.relations.zeroQualifyingLayoutObserved).toBe(false);
    expect(
      evidence.dom
        .filter(
          (record) =>
            record.kind === "attribute" && record.attribute === "aria-valuenow",
        )
        .map((record) => record.oldValue),
    ).toEqual(["0", "50"]);
    expect(
      evidence.geometry.some(
        (record) => record.percent === 100 && record.excluded.length === 0,
      ),
    ).toBe(true);
    expect(evidence.producerEmissionCount.status).toBe("unavailable");
    expect(await observation.finish()).toBe(evidence);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await retainConformance(observation, failure);
  }
});

test("collector excludes actual ancestor clipping then samples after scripted scroll", async ({
  page,
}) => {
  await page.goto("/api/health");
  await page.setContent(
    '<div class="pipeline-panel" style="height:20px; overflow:auto"><div style="height:40px"></div></div>',
  );
  const observation = await armNativeProgress(page);
  observation.core.bind(
    {
      id: "geometry-conformance",
      status: "running",
      current: 1,
      total: 2,
      steps: [],
    },
    performance.now(),
  );
  let failure: unknown;
  try {
    await page.evaluate(async () => {
      const panel = document.querySelector(".pipeline-panel") as HTMLElement;
      const bar = document.createElement("div");
      bar.className = "pipeline-bar";
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuenow", "50");
      bar.style.width = "100px";
      bar.style.height = "8px";
      bar.innerHTML =
        '<div class="pipeline-bar-fill" style="height:8px;width:50px"></div>';
      panel.append(bar);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      panel.scrollTop = panel.scrollHeight;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      panel.style.visibility = "hidden";
      bar.setAttribute("aria-valuenow", "51");
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    const evidence = await observation.finish();
    expect(
      evidence.geometry.some((record) =>
        record.excluded.includes("rectangularly-clipped"),
      ),
    ).toBe(true);
    expect(
      evidence.geometry.some(
        (record) => record.qualification === "qualifying-rectangular-layout",
      ),
    ).toBe(true);
    expect(
      evidence.geometry.some((record) =>
        record.excluded.includes("CSS-hidden"),
      ),
    ).toBe(true);
    expect(evidence.channelAvailability.nativeReceipt).toBe("unavailable");
    expect(evidence.observationIntegrity).toBe("incomplete");
    expect(evidence.cleanupFailures).toEqual([]);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await retainConformance(observation, failure);
  }
});
