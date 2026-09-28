import { expect, type Page, type Route } from "@playwright/test";

export type CapturedCommentCommand = {
  command_id: string;
  client_id: string;
  client_seq: number;
  type: string;
};

/** Fail AddComment while offline and retain every attempted command for replay checks. */
export async function interceptCommentCommands(page: Page): Promise<{
  commands: CapturedCommentCommand[];
  forwarded: CapturedCommentCommand[];
  setOffline: (offline: boolean) => void;
}> {
  const commands: CapturedCommentCommand[] = [];
  const forwarded: CapturedCommentCommand[] = [];
  let offline = true;
  await page.route("**/api/document/command?*", async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    const command = route.request().postDataJSON() as CapturedCommentCommand;
    if (command.type !== "AddComment") return route.continue();
    commands.push(command);
    if (offline) return route.abort("failed");
    forwarded.push(command);
    return route.continue();
  });
  return {
    commands,
    forwarded,
    setOffline: (value) => {
      offline = value;
    },
  };
}

/** Open the comment composer and submit one anchored host comment. */
export async function postHostComment(page: Page, body: string): Promise<void> {
  await page
    .getByLabel("Editor panels")
    .getByRole("button", { name: "Comments" })
    .click();
  await page.getByRole("button", { name: "Comment mode" }).click();
  await page.getByRole("slider", { name: "Comment time anchor" }).click();
  await expect(page.getByText("Commenting as")).toContainText("Host");
  await page.getByPlaceholder("Feedback…").fill(body);
  await page.getByRole("button", { name: "Post comment" }).click();
}
