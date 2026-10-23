import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { e2eProjectPath } from "./env";

const desktop = process.env.ISSUE2159_DESKTOP === "1";
const shell = desktop ? "desktop" : "phone";
const phase = process.env.ISSUE2159_PHASE ?? "before";
const evidence = process.env.ISSUE2159_EVIDENCE_OUT ?? "/tmp/sharecut-pr2219";
fs.mkdirSync(evidence, { recursive: true });
test.use({ hasTouch: !desktop, colorScheme: "light" });

test(`issue2159 ${shell} refused approval recovery`, async ({ page }) => {
	await openSuggestedPendingEdit(page, e2eProjectPath);
	const editId = await page
		.locator(".pending-overlay.selected")
		.getAttribute("data-pending-id");
	expect(editId).toBeTruthy();
	const sheet = page.locator(".bottom-sheet--inspector");
	if (!desktop) {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.getByRole("button", { name: "Timeline", exact: true }).click();
		await expect(sheet).toBeVisible();
		for (let step = 0; step < 2; step++) {
			const expand = sheet.getByRole("button", {
				name: /^Expand(?: to (?:half|full) height)?$/,
				exact: true,
			});
			if (!(await expand.count())) break;
			await expand.click();
		}
	}
	const inspector = page
		.locator(".modifier-inspector")
		.filter({
			has: page.getByRole("heading", { name: "Pending edit", exact: true }),
		});
	await inspector.getByRole("button", { name: "Approve", exact: true }).click();
	await expect(inspector.getByLabel("Waiver reason")).toBeVisible();
	console.log(
		"REFUSED",
		await page.getByRole("region", { name: /^Needs attention/ }).count(),
	);
	await inspector
		.getByLabel("Waiver reason")
		.fill("Issue2159 runtime reproduction");
	await inspector
		.getByRole("button", { name: "Waive with reason", exact: true })
		.click();
	await expect(
		inspector.getByText(
			"Waiver recorded. Retry approval to apply pending edits.",
		),
	).toBeVisible();
	await inspector.getByRole("button", { name: "Approve", exact: true }).click();
	const feedback = page.getByRole("region", { name: "Status messages" });
	await expect(feedback).toContainText("Approved 1 pending edit");
	const pendingIds = async () => {
		const result = await page.request.get(
			`/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=shell`,
		);
		const project = await result.json();
		return project.pending_edits.map((edit: { id: string }) => edit.id);
	};
	await expect.poll(pendingIds).not.toContain(editId);
	console.log("PENDING_AFTER", JSON.stringify(await pendingIds()));
	console.log(
		"AFTER",
		JSON.stringify({
			shell,
			sheet: await sheet.count(),
			missing: await page.getByText("Edit not found", { exact: true }).count(),
			attention: await page
				.getByRole("region", { name: /^Needs attention/ })
				.count(),
		}),
	);
	await page.screenshot({
		path: path.join(evidence, `2159-${shell}-${phase}.png`),
	});
	await expect(page.getByText("Edit not found", { exact: true })).toHaveCount(
		0,
	);
	if (!desktop) await expect(sheet).toHaveCount(0);
	await expect(
		page.getByRole("region", { name: /^Needs attention/ }),
	).toHaveCount(0);
	await feedback.getByRole("button", { name: "Undo", exact: true }).click();
	await expect.poll(pendingIds).toContain(editId);
	console.log("UNDO_RESTORED", editId);
});
