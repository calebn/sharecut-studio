import { expect, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { openScript } from "./transcriptEdit";
import { withBrowserPages } from "./twoBrowserPages";

test("an Editor words menu keeps Mute on ignored words without host Restore", async ({
  browser,
}) => {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [{}, { viewport: { width: 1280, height: 800 } }],
      async ([host, editor]) => {
        await openHostShare(host, projectPath);
        await postDocumentCommand(
          host,
          "words-role-proof",
          "SetTranscriptWordsIgnored",
          {
            track_id: "reference",
            start_word_index: 3,
            end_word_index: 3,
            ignored: true,
          },
          projectPath,
        );
        const token = await createReviewShare(host, projectPath, "editor");
        await openGuestShare(editor, token);
        const script = await openScript(editor);
        const word = script.locator('[data-word-key="reference::3"]');
        await expect(word).toHaveAttribute("data-state", "muted");
        await word.click();
        await expect(word).toHaveAttribute("data-selected");
        await editor
          .getByRole("group", { name: "Selection actions" })
          .getByRole("button", { name: /^More/ })
          .click();
        await expect(
          editor.getByRole("menuitem", { name: "Mute", exact: true }),
        ).toBeVisible();
        await expect(
          editor.getByRole("menuitem", {
            name: "Restore ignored words",
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(
          editor.getByRole("menuitem", { name: "Suggest mute", exact: true }),
        ).toHaveCount(0);
        await editor.screenshot({
          path: "playwright-report/words-actionbar/editor-more.png",
        });
      },
    );
  });
});
