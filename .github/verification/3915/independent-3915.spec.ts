import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { createScriptRecordingIdentityProject } from "./scriptRecordingIdentityProject";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { openScript } from "./transcriptEdit";
const records: {ordinal: number; status: "PASS" | "REGRESSION"}[] = [];
function mark(ordinal: number, status: "PASS" | "REGRESSION" = "PASS") {
  records.push({ordinal, status});
  fs.writeFileSync(process.env.V3915_RECORDS!, JSON.stringify(records));
}
test("independent3915", async ({page, browser}) => {
  fs.writeFileSync(process.env.V3915_BROWSER!, browser.version());
  let regressionObserved = false;
  await withShareableProject(async projectPath => {
    await page.setViewportSize({width:1440,height:900});
    await openProject(page, projectPath);
    const body = await openScript(page);
    mark(1);
    const showCut = page.getByRole("button", {name:"Show cut text",exact:true});
    if ((await showCut.getAttribute("aria-pressed")) !== "true") await showCut.click();
    await expect(showCut).toHaveAttribute("aria-pressed","true"); mark(2);
    await expect(body.locator(".sys-script-word").filter({hasText:/^echo$/})).toHaveCount(2); mark(3);
    const cut = body.locator('.sys-script-word[data-word-key="host::-2"]');
    const other = body.locator('.sys-script-word[data-word-key="host:other:1"]');
    await expect(cut).toHaveText("echo");
    await expect(cut).toHaveAttribute("data-state","cut");
    await expect(other).toHaveText("echo"); mark(4);
    // Only this exact observable wrong state can qualify as the parent regression.
    const state = await other.getAttribute("data-state");
    if (state === "cut") {
      mark(5,"REGRESSION"); regressionObserved = true;
      return; // Do not throw until withShareableProject restores and removes successfully.
    }
    await expect(other).not.toHaveAttribute("data-state","cut"); mark(5);
    await page.getByRole("button",{name:"Find in transcript"}).click();
    const bar = page.getByRole("search",{name:"Find in transcript"});
    const field = bar.getByRole("searchbox",{name:"Find",exact:true});
    await field.fill("echo"); await expect(bar).toContainText("1 of 1"); mark(6);
    await expect(other).toHaveAttribute("data-found"); mark(7);
    await expect(cut).not.toHaveAttribute("data-found"); mark(8);
    await field.fill("alpha omega"); await expect(bar).toContainText("No matches"); mark(9);
    await field.fill("omega beta"); await expect(bar).toContainText("No matches"); mark(10);
    await field.fill("beta echo"); await expect(bar).toContainText("1 of 1"); mark(11);
  }, undefined, createScriptRecordingIdentityProject);
  mark(12); // Successful helper restoration/removal, not merely wrapper cleanup.
  if (regressionObserved) throw new Error("V3915_EXPECTED_REGRESSION");
});
