import { expect, type Page, type Response, test } from "@playwright/test";
import { withSharedProject } from "./guestLink";
import { selectionBar } from "./pendingActionbar";
import { openGuestShare } from "./shareNavigation";

const DESKTOP = { viewport: { width: 1280, height: 800 } };

const isCommand = (type: string) => (response: Response) =>
  response.request().method() === "POST" &&
  /\/document\/command/.test(response.url()) &&
  response.request().postDataJSON()?.type === type;

const word = (page: Page, text: string) =>
  page
    .getByRole("region", { name: "Script" })
    .getByRole("button", { name: text, exact: true });

async function pendingCount(host: Page, projectPath: string): Promise<number> {
  const res = await host.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { pending_edits: unknown[] }).pending_edits
    .length;
}

test("the host approves a Commenter's range proposal on the Action bar", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP, DESKTOP],
    ["commenter"],
    async ([host, commenter], links, projectPath) => {
      await openGuestShare(commenter!, links.commenter!);
      await word(commenter!, "moody").first().click();
      await selectionBar(commenter!)
        .getByRole("button", { name: "Suggest a cut" })
        .click();
      await expect.poll(() => pendingCount(host!, projectPath)).toBe(1);

      await host!.locator(".pending-overlay .pending-hit").first().click();
      await expect(
        host!.getByRole("region", { name: "Pending edit actions" }),
      ).toHaveCount(0);
      const bar = selectionBar(host!);
      await expect(
        bar.getByRole("button", { name: "Reject", exact: true }),
      ).toBeEnabled();
      const approved = host!.waitForResponse(isCommand("ApproveEdits"));
      await bar.getByRole("button", { name: "Approve", exact: true }).click();
      expect((await approved).status()).toBe(200);
      await expect.poll(() => pendingCount(host!, projectPath)).toBe(0);
    },
  );
});
