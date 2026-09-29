import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return Object.fromEntries(Object.entries(value));
}

test("turns off a saved alignment request when its model is missing", async ({
  page,
}, testInfo) => {
  const response = await page.request.get(
    `/api/pipeline/config?path=${encodeURIComponent(e2eProjectPath)}`,
  );
  expect(response.ok()).toBe(true);

  const serverConfig = asRecord(await response.json());
  const serverValues = asRecord(serverConfig.config);
  const transcribe = asRecord(serverValues.transcribe);
  const blockedValues = structuredClone(serverValues);
  blockedValues.transcribe = {
    ...transcribe,
    forced_alignment: { enabled: true },
  };
  const blockedConfig = {
    ...serverConfig,
    config: blockedValues,
    forced_alignment: {
      enabled: false,
      model: null,
      requested: true,
      installed: false,
      blocked: true,
      reason:
        "blocked: transcribe.forced_alignment.enabled is true but word aligner 'onnx-base' is not downloaded (podcast bootstrap --component word-aligner)",
    },
    components: {
      ...asRecord(serverConfig.components),
      "word-aligner": {
        ok: false,
        opt_in: true,
        size: "~360 MB",
        hint: "Word aligner is not downloaded",
      },
    },
  };
  let savedConfig: Record<string, unknown> | undefined;

  await page.route("**/api/pipeline/config**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ response, json: blockedConfig });
      return;
    }

    const body = asRecord(route.request().postDataJSON());
    savedConfig = asRecord(body.config);
    const savedTranscribe = asRecord(savedConfig.transcribe);
    expect(asRecord(savedTranscribe.forced_alignment).enabled).toBe(false);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...blockedConfig,
        config: savedConfig,
        forced_alignment: {
          enabled: false,
          model: null,
          requested: false,
          installed: false,
          blocked: false,
          reason: "off: transcribe.forced_alignment.enabled is false",
        },
      }),
    });
  });

  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
  await page
    .getByLabel("Editor panels")
    .getByRole("button", { name: "Pipeline", exact: true })
    .click();
  await page.getByRole("button", { name: "Transcribe tracks" }).click();
  await page.getByRole("button", { name: "Show advanced" }).click();

  const toggle = page.getByRole("checkbox", {
    name: "Precise word boundaries",
  });
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(page.locator(".pipeline-aligner [role=status]")).toContainText(
    "This saved request can be turned off here.",
  );
  await page.screenshot({
    path: testInfo.outputPath("blocked-aligner-request.png"),
  });

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  expect(savedConfig).toEqual({
    ...blockedValues,
    transcribe: {
      ...transcribe,
      forced_alignment: { enabled: false },
    },
  });
});
