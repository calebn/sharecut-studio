import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";

/** A tenth of a second of silence: enough for the server to take as a track. */
function silentWav(): Buffer {
  const rate = 8000;
  const samples = rate / 10;
  const data = samples * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data, 40);
  return Buffer.concat([header, Buffer.alloc(data)]);
}

test("Prepare: the hand-off opens the next stage once the sources are ready", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath, { stage: "prepare" });
  const handoff = page.getByRole("button", { name: /^(Edit|Review)/ });
  await expect(handoff).toBeEnabled();
  await handoff.click();
  await expect(
    page.getByRole("tab", { name: /^(Edit|Review)\b/, selected: true }),
  ).toBeVisible();
});

test("Prepare: importing audio starts the run by itself and shows a waiting Run when the slot is busy", async ({
  page,
}) => {
  // The import adds a take: do it in a disposable copy so the shared project is left as found.
  await withShareableProject(async (projectPath) => {
    let posts = 0;
    let body: Record<string, unknown> | null = null;
    // The run is mocked: this spec is about when Prepare starts it, not about transcribing.
    await page.route("**/api/pipeline/run", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      posts += 1;
      body = route.request().postDataJSON();
      await route.fulfill({
        status: 409,
        headers: { "X-Sharecut-Error-Code": "pipeline_busy" },
        json: { detail: "A pipeline job is already running" },
      });
    });
    await openProject(page, projectPath, { stage: "prepare" });
    await expect(
      page.getByRole("heading", { name: "Sources", exact: true }),
    ).toBeVisible();
    expect(posts).toBe(0);

    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: /^Import audio/ })
      .first()
      .click();
    await (await chooser).setFiles({
      name: "intro.wav",
      mimeType: "audio/wav",
      buffer: silentWav(),
    });

    await expect.poll(() => posts).toBeGreaterThanOrEqual(1);
    expect(body).toMatchObject({ use_working_set: true });
    expect(body).not.toHaveProperty("force_transcribe", true);

    // The mock refuses the run (slot busy): Prepare says it is waiting and offers Run, not silence.
    await expect(
      page
        .getByText(/Another job is running\. This starts when it finishes/)
        .first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Run/ }).first(),
    ).toBeVisible();
    await expect(page.getByText("Still getting ready")).toHaveCount(0);
  });
});

test("Prepare: Advanced opens the step sheet and Escape returns to the stage", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath, { stage: "prepare" });
  const advanced = page.getByRole("button", { name: /^Advanced/ });
  await advanced.click();
  // The sheet's title and the step list's own heading share the name.
  const sheet = page.getByRole("dialog", { name: "Advanced steps" });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(advanced).toBeFocused();
});
