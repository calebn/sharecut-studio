import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { expectSurfaceAxeClean } from "./axe";
import { registerE2eCleanupWorkspace } from "./cleanupManifest";
import { repoRoot } from "./env";
import { withShareableProject } from "./shareableProject";
import { goToStage, openProject } from "./stageNav";

const python = process.env.CI
  ? "python"
  : path.join(repoRoot, ".venv/bin/python");

function syntheticEpisode(prefix: string) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerE2eCleanupWorkspace(workspaceDir);
  const projectPath = execFileSync(
    python,
    [
      "-c",
      [
        "import sys",
        "from pathlib import Path",
        "from tests.daw_export_fixture import create_daw_export_project",
        "print(create_daw_export_project(Path(sys.argv[1]).resolve()).path)",
      ].join("\n"),
      workspaceDir,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
  return { workspaceDir, projectPath };
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test(`download an editable session at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await withShareableProject(
      async (projectPath) => {
        await openProject(page, projectPath);
        await goToStage(page, "deliver");
        const saved = fs.readFileSync(projectPath);
        const section = page.getByRole("region", {
          name: "Editable DAW session",
        });
        const picker = section.getByLabel("DAW format");
        await picker.selectOption("sesx");
        await expect(section.getByText(/Audition is unverified/)).toBeVisible();
        await expect(
          page
            .getByRole("region", { name: "Episode file" })
            .getByText("WAV", { exact: true })
            .first(),
        ).toBeVisible();
        await section
          .getByRole("button", { name: "Export DAW session" })
          .click();
        const link = section.getByRole("link", {
          name: /Download session-sesx.zip/,
        });
        await expect(link).toBeVisible();
        await expectSurfaceAxeClean(
          page,
          "section:has(select[id]):has(.dv-files)",
        );
        const waiting = page.waitForEvent("download");
        await link.click();
        const artifact = info.outputPath("session-sesx.zip");
        await (await waiting).saveAs(artifact);
        const members = execFileSync(
          python,
          [
            "-c",
            [
              "import sys, zipfile, xml.etree.ElementTree as ET",
              "with zipfile.ZipFile(sys.argv[1]) as package:",
              "    doc = ET.fromstring(package.read('session.sesx'))",
              "    assert len(doc.findall('.//audioClip')) == 4",
              "    for entry in doc.findall('.//file'):",
              "        name = entry.attrib['relativePath']",
              "        assert name.startswith('media/') and package.read(name)[:4] == b'RIFF'",
              "    print(len(package.namelist()))",
            ].join("\n"),
            artifact,
          ],
          { encoding: "utf8" },
        ).trim();
        expect(members).toBe("3");
        expect(fs.readFileSync(projectPath).equals(saved)).toBe(true);
        await section.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath("deliver.png") });
        if (viewport.width === 1280) {
          await page
            .getByRole("button", { name: "Export", exact: true })
            .click();
          const wav = page.getByRole("link", {
            name: /^Download episode\.wav,/,
          });
          const downloaded = page.waitForEvent("download");
          await wav.click();
          const fallback = info.outputPath("rendered.wav");
          await (await downloaded).saveAs(fallback);
          expect(fs.readFileSync(fallback).subarray(8, 12).toString()).toBe(
            "WAVE",
          );
        }
      },
      undefined,
      syntheticEpisode,
    );
  });
}
