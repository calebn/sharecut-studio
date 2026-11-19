import fs from "node:fs";
import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type Response,
  test,
} from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
import { expectFeedback } from "./feedback";
import { withSharedProject } from "./guestLink";
import { openGuestShare } from "./shareNavigation";

/**
 * An Editor on a review link edits the host's episode with the hand edits the
 * host has: Cut, Mute, Approve and Keep of a Commenter's suggestion, Fix text,
 * Replace, Keep on a cut seam, and an Undo of the Editor's own step. A hold
 * that remains is told in words and is never filed as a conflict. Every check
 * reads the host's page or the host's own read of the episode, not the
 * guest's copy.
 */

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
};
const PROOF_DIR = process.env.UI_PROOF_DIR;

const COUNT_ERROR = "The review reply is missing its affected edit count.";
const HELD_REASON =
  "that part of the recording is no longer in one piece on the timeline";
const CUT_SEAM_SENTENCE =
  "This cut can't be put back on its own. Undo takes back your own latest change; for anything else, ask the host.";

type Served = {
  clips: {
    tracks: Record<
      string,
      {
        id: string;
        source_start: number;
        source_end: number;
        mute_regions: { start_s: number; end_s: number }[];
      }[]
    >;
  };
  pending_edits: { id: string }[];
  chapters: { title: string }[];
};

async function served(host: Page, projectPath: string): Promise<Served> {
  const res = await host.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Served;
}

async function spans(host: Page, projectPath: string, track: string) {
  const project = await served(host, projectPath);
  return project.clips.tracks[track]!.map((clip) => [
    clip.source_start,
    clip.source_end,
  ]);
}

async function mutes(host: Page, projectPath: string, track: string) {
  const project = await served(host, projectPath);
  return project.clips.tracks[track]!.flatMap((clip) =>
    clip.mute_regions.map((region) => [region.start_s, region.end_s]),
  );
}

function isCommand(type: string) {
  return (response: Response) =>
    response.request().method() === "POST" &&
    /\/daw\/document\/command/.test(response.url()) &&
    response.request().postDataJSON()?.type === type;
}

const script = (page: Page) => page.getByRole("region", { name: "Script" });
const word = (page: Page, text: string | RegExp) =>
  script(page).getByRole("button", {
    name: text,
    ...(typeof text === "string" ? { exact: true } : {}),
  });
const bar = (page: Page) =>
  page.getByRole("group", { name: /^(Selection|Edit) actions$/ });
const attention = (page: Page) =>
  page.getByRole("group", { name: /^Needs attention/ });
const toast = (page: Page) => page.locator(".ui-toast-region--app");
const cutMark = (page: Page, length: string) =>
  script(page).getByRole("button", { name: `Cut, ${length} removed` });

async function pressCut(guest: Page, type: string): Promise<void> {
  const sent = guest.waitForResponse(isCommand(type));
  await bar(guest).getByRole("button", { name: "Cut", exact: true }).click();
  expect((await sent).status()).toBe(200);
}

async function proof(page: Page, name: string): Promise<void> {
  if (!PROOF_DIR) return;
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: path.join(PROOF_DIR, `${name}-light.png`) });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: path.join(PROOF_DIR, `${name}-dark.png`) });
  await page.emulateMedia({ colorScheme: "light" });
}

async function waiveRefineGate(host: Page, projectPath: string): Promise<void> {
  const waived = await host.request.post("/api/transcript/refine/waive", {
    data: { path: projectPath, reason: "e2e guest editor edits" },
  });
  expect(waived.ok(), await waived.text()).toBe(true);
}

async function stageWordCut(
  host: Page,
  projectPath: string,
  wordIndex: number,
): Promise<string> {
  await waiveRefineGate(host, projectPath);
  await postDocumentCommand(
    host,
    "e2e-guest-editor",
    "StageWordsCut",
    {
      track_id: "reference",
      start_word_index: wordIndex,
      end_word_index: wordIndex,
    },
    projectPath,
  );
  const { pending_edits } = await served(host, projectPath);
  expect(pending_edits).toHaveLength(1);
  return pending_edits[0]!.id;
}

async function commenterSuggestsCut(
  commenter: Page,
  text: string,
): Promise<void> {
  await word(commenter, text).first().click();
  const sent = commenter.waitForResponse(isCommand("EditSelectedRange"));
  await bar(commenter).getByRole("button", { name: "Suggest a cut" }).click();
  expect((await sent).status()).toBe(200);
  await expectFeedback(commenter, "Range suggestion sent for host review");
}

async function openReviewCard(editor: Page): Promise<Locator> {
  await editor.getByRole("tab", { name: /^Review/ }).click();
  const card = editor.getByRole("article");
  await expect(card).toBeVisible();
  return card;
}

test("an Editor's Cut lands on the host's episode and Undo on the toast takes it back", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP],
    ["editor"],
    async ([host, guest], links, projectPath) => {
      await openGuestShare(guest!, links.editor!);
      await word(guest!, "uncle").first().click();
      await pressCut(guest!, "EditSelectedRange");

      await expectFeedback(guest!, 'Cut "uncle" · 0.3 s · 1 more');
      await expect(cutMark(guest!, "0.3 s")).toHaveCount(1);
      await expect(attention(guest!)).toHaveCount(0);
      await expect(cutMark(host!, "0.3 s")).toHaveCount(1);
      expect(await spans(host!, projectPath, "reference")).toEqual([
        [0, 2.53],
        [2.79, 60],
      ]);
      await expectPageAxeClean(guest!);
      await proof(guest!, "editor-cut");

      await toast(guest!).getByRole("button", { name: /undo/i }).click();
      await expect(cutMark(guest!, "0.3 s")).toHaveCount(0);
      await expect(cutMark(host!, "0.3 s")).toHaveCount(0);
      expect(await spans(host!, projectPath, "reference")).toEqual([[0, 60]]);
    },
  );
});

test("an Editor's Cut on a phone lands on the host's episode and Undo on the toast takes it back", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [PHONE],
    ["editor"],
    async ([host, guest], links, projectPath) => {
      await openGuestShare(guest!, links.editor!);
      await guest!.getByRole("button", { name: "Dismiss hint" }).tap();
      await guest!
        .getByRole("group", { name: "Edit surface" })
        .getByRole("button", { name: "Script" })
        .tap();
      await word(guest!, "uncle").first().tap();
      const sent = guest!.waitForResponse(isCommand("EditSelectedRange"));
      await bar(guest!).getByRole("button", { name: "Cut", exact: true }).tap();
      expect((await sent).status()).toBe(200);

      await expectFeedback(guest!, 'Cut "uncle" · 0.3 s · 1 more');
      await expect(attention(guest!)).toHaveCount(0);
      await expect(cutMark(host!, "0.3 s")).toHaveCount(1);
      expect(await spans(host!, projectPath, "reference")).toEqual([
        [0, 2.53],
        [2.79, 60],
      ]);
      expect(
        await guest!.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);

      await toast(guest!).getByRole("button", { name: /undo/i }).tap();
      await expect(cutMark(host!, "0.3 s")).toHaveCount(0);
      expect(await spans(host!, projectPath, "reference")).toEqual([[0, 60]]);
    },
  );
});

test("an Editor's Mute lands on the host's episode, and Undo and Redo take back only the Editor's own step", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP],
    ["editor"],
    async ([host, guest], links, projectPath) => {
      await postDocumentCommand(
        host!,
        "e2e-host",
        "AddChapter",
        { time: 6, title: "Hosts" },
        projectPath,
      );
      await openGuestShare(guest!, links.editor!);
      await expect(guest!.getByLabel("Chapter Hosts")).toBeVisible();
      await word(guest!, "moody").first().click();
      await bar(guest!).getByRole("button", { name: "More" }).click();
      const sent = guest!.waitForResponse(isCommand("EditSelectedRange"));
      await guest!.getByRole("menuitem", { name: "Mute" }).click();
      expect((await sent).status()).toBe(200);

      await expectFeedback(
        guest!,
        "Range mute applied. Use Undo to restore it.",
      );
      await expect(attention(guest!)).toHaveCount(0);
      expect(await mutes(host!, projectPath, "reference")).toEqual([
        [4.9, 5.27],
      ]);

      const undone = guest!.waitForResponse(isCommand("UndoHistory"));
      await guest!.locator('button[aria-label="Undo"]').click();
      expect((await undone).status()).toBe(200);
      await expect
        .poll(() => mutes(host!, projectPath, "reference"))
        .toEqual([]);
      expect(
        (await served(host!, projectPath)).chapters.map((c) => c.title),
      ).toEqual(["Hosts"]);

      const redone = guest!.waitForResponse(isCommand("RedoHistory"));
      await guest!.locator('button[aria-label="Redo"]').click();
      expect((await redone).status()).toBe(200);
      await expect
        .poll(() => mutes(host!, projectPath, "reference"))
        .toEqual([[4.9, 5.27]]);
    },
  );
});

test("an Editor approves a Commenter's suggested cut and the host sees it cut", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP, DESKTOP],
    ["editor", "commenter"],
    async ([host, editor, commenter], links, projectPath) => {
      await openGuestShare(editor!, links.editor!);
      await openGuestShare(commenter!, links.commenter!);
      await commenterSuggestsCut(commenter!, "moody");
      expect((await served(host!, projectPath)).pending_edits).toHaveLength(1);

      const card = await openReviewCard(editor!);
      const approved = editor!.waitForResponse(isCommand("ApproveEdits"));
      await card.getByRole("button", { name: "Cut", exact: true }).click();
      expect((await approved).status()).toBe(200);

      await expectFeedback(editor!, "Cut");
      await expect(editor!.getByRole("alert")).toHaveCount(0);
      await expect(editor!.getByText(COUNT_ERROR)).toHaveCount(0);
      await expect(attention(editor!)).toHaveCount(0);
      expect((await served(host!, projectPath)).pending_edits).toEqual([]);
      expect(await spans(host!, projectPath, "reference")).toEqual([
        [0, 4.9],
        [5.27, 60],
      ]);
      await expect(cutMark(host!, "0.4 s")).toHaveCount(1);
    },
  );
});

test("an Editor keeps a Commenter's suggestion without a false error and the host's list empties", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP, DESKTOP],
    ["editor", "commenter"],
    async ([host, editor, commenter], links, projectPath) => {
      await openGuestShare(editor!, links.editor!);
      await openGuestShare(commenter!, links.commenter!);
      await commenterSuggestsCut(commenter!, "moody");

      const card = await openReviewCard(editor!);
      const rejected = editor!.waitForResponse(isCommand("RejectEdits"));
      await card.getByRole("button", { name: "Keep", exact: true }).click();
      expect((await rejected).status()).toBe(200);

      await expectFeedback(editor!, "Kept");
      await expect(editor!.getByRole("alert")).toHaveCount(0);
      await expect(editor!.getByText(COUNT_ERROR)).toHaveCount(0);
      await expect(attention(editor!)).toHaveCount(0);
      expect((await served(host!, projectPath)).pending_edits).toEqual([]);
      expect(await spans(host!, projectPath, "reference")).toEqual([[0, 60]]);
    },
  );
});

test("an Editor puts back the host's approved cut, and reads why their own range cut can't be put back", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP],
    ["editor"],
    async ([host, guest], links, projectPath) => {
      const id = await stageWordCut(host!, projectPath, 1);
      await postDocumentCommand(
        host!,
        "e2e-guest-editor",
        "ApproveEdits",
        { ids: [id] },
        projectPath,
      );
      await openGuestShare(guest!, links.editor!);
      const seam = guest!
        .locator(".lane-row")
        .first()
        .locator(".seam-mark .sys-seam-hit");
      await expect(seam).toHaveCount(1);
      await seam.click();
      const restored = guest!.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /\/daw\/document\/command/.test(response.url()) &&
          response.status() === 200,
      );
      await bar(guest!)
        .getByRole("button", { name: "Keep", exact: true })
        .click();
      await restored;
      await expect(seam).toHaveCount(2);
      await expect(attention(guest!)).toHaveCount(0);
      expect(await spans(host!, projectPath, "reference")).toEqual([
        [0, 2.5349999999999997],
        [2.5349999999999997, 2.97525],
        [2.97525, 60],
      ]);
      await expect(
        script(host!).getByRole("button", { name: /^Cut, .* removed$/ }),
      ).toHaveCount(0);

      await word(guest!, "moody").first().click();
      await pressCut(guest!, "EditSelectedRange");
      await expect(seam).toHaveCount(3);
      await seam.last().click();
      const keep = bar(guest!).getByRole("button", {
        name: "Keep",
        exact: true,
      });
      await expect(keep).toBeDisabled();
      await expect(bar(guest!)).toContainText(CUT_SEAM_SENTENCE);
      await expect(guest!.getByRole("dialog")).toHaveCount(0);
    },
  );
});

test("an Editor fixes a word and replaces one match, the host sees both, and Undo takes the fix back", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP],
    ["editor"],
    async ([host, guest], links) => {
      await openGuestShare(guest!, links.editor!);
      await word(guest!, "uncle").first().click();
      await bar(guest!).getByRole("button", { name: "Fix text" }).click();
      const field = script(guest!).getByRole("textbox", { name: "Fix text" });
      await expect(field).toHaveValue("uncle");
      const fixed = guest!.waitForResponse(isCommand("CorrectTranscriptWord"));
      await field.fill("Uncle");
      await field.press("Enter");
      expect((await fixed).status()).toBe(200);

      await expectFeedback(guest!, "Text fixed: Uncle");
      await expect(word(guest!, /^Uncle/)).toHaveCount(1);
      await expect(word(host!, /^Uncle/)).toHaveCount(1);
      await expect(attention(guest!)).toHaveCount(0);

      await guest!.keyboard.press("ControlOrMeta+Z");
      await expect(word(guest!, /^Uncle/)).toHaveCount(0);
      await expect(word(host!, /^Uncle/)).toHaveCount(0);
      await expect(word(host!, /^uncle/)).toHaveCount(2);

      await guest!.getByRole("button", { name: "Find in transcript" }).click();
      await guest!.getByRole("searchbox", { name: "Find" }).fill("uncle");
      await guest!.getByRole("button", { name: "Show replace" }).click();
      await guest!.getByRole("textbox", { name: "Replace with" }).fill("Uncle");
      const replaced = guest!.waitForResponse(
        isCommand("ReplaceTranscriptMatches"),
      );
      await guest!
        .getByRole("button", { name: "Replace", exact: true })
        .click();
      expect((await replaced).status()).toBe(200);
      await expect(word(host!, /^Uncle/)).toHaveCount(1);
      await expect(word(host!, /^uncle/)).toHaveCount(1);
      await expect(attention(guest!)).toHaveCount(0);
    },
  );
});

test("a Commenter link offers no Fix text and never reads Host project required", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP],
    ["commenter"],
    async ([, guest], links) => {
      await openGuestShare(guest!, links.commenter!);
      await word(guest!, "uncle").first().click();
      await expect(bar(guest!).getByRole("button")).toHaveCount(2);
      await expect(
        bar(guest!).getByRole("button", { name: "Suggest a cut" }),
      ).toBeVisible();
      await expect(
        bar(guest!).getByRole("button", { name: "Fix text" }),
      ).toHaveCount(0);
      await guest!.keyboard.press("F2");
      await expect(
        script(guest!).getByRole("textbox", { name: "Fix text" }),
      ).toHaveCount(0);
      await guest!.getByRole("button", { name: "Palette" }).click();
      await guest!
        .getByRole("combobox", { name: "Search commands" })
        .fill("Fix text");
      await expect(guest!.getByRole("option")).toHaveCount(0);
      await expect(guest!.getByText(/Host project required/)).toHaveCount(0);
    },
  );
});

test("an edit the server holds is told in words on the Editor's Review page and filed as no conflict", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP],
    ["editor"],
    async ([host, guest], links, projectPath) => {
      await stageWordCut(host!, projectPath, 1);
      await postDocumentCommand(
        host!,
        "e2e-guest-editor",
        "SplitAtTime",
        { at_time: 2.65, track_ids: ["reference"] },
        projectPath,
      );
      const right = (await served(host!, projectPath)).clips.tracks[
        "reference"
      ]!.find((clip) => clip.source_start > 2)!;
      await postDocumentCommand(
        host!,
        "e2e-guest-editor",
        "MoveClips",
        {
          clips: [
            {
              clip_id: right.id,
              timeline_start: right.source_start + 1,
              track_id: "reference",
            },
          ],
        },
        projectPath,
      );

      await openGuestShare(guest!, links.editor!);
      const card = await openReviewCard(guest!);
      const approved = guest!.waitForResponse(isCommand("ApproveEdits"));
      await card.getByRole("button", { name: "Cut", exact: true }).click();
      expect((await approved).status()).toBe(200);

      const held = `Applied 0, held 1. Reference's cut at 0:02.5 is held: ${HELD_REASON}.`;
      await expectFeedback(guest!, held);
      await expect(card).toContainText(HELD_REASON);
      await expect(card).toContainText("The host resolves this one.");
      await expect(attention(guest!)).toHaveCount(0);
      await expect(guest!.getByRole("alert")).toHaveCount(0);
      const page = await guest!.locator("body").innerText();
      for (const engineer of [
        "geometry",
        "override",
        "conflict",
        path.dirname(projectPath),
      ])
        expect(page).not.toContain(engineer);
      expect((await served(host!, projectPath)).pending_edits).toHaveLength(1);
      await expectPageAxeClean(guest!);
      await proof(guest!, "editor-held-cut");
    },
  );
});

test("an Editor's Approve of a ripple cut over the other speaker's words applies with no confirmation ask, as the host's does", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [DESKTOP],
    ["editor"],
    async ([host, guest], links, projectPath) => {
      await waiveRefineGate(host!, projectPath);
      await postDocumentCommand(
        host!,
        "e2e-guest-editor",
        "StageTimeRangeCut",
        {
          track_id: "reference",
          start: 8.5,
          end: 9.4,
          reason: "filler:um",
          review_required: true,
        },
        projectPath,
      );
      await openGuestShare(guest!, links.editor!);
      const card = await openReviewCard(guest!);
      const approved = guest!.waitForResponse(isCommand("ApproveEdits"));
      await card.getByRole("button", { name: "Cut", exact: true }).click();
      const reply = await approved;
      expect(reply.status()).toBe(200);
      expect(Object.keys(await reply.json())).not.toContain(
        "needs_confirmation",
      );

      await expectFeedback(guest!, "Cut 0.9 s");
      await expect(guest!.getByRole("dialog")).toHaveCount(0);
      await expect(guest!.getByRole("alert")).toHaveCount(0);
      await expect(attention(guest!)).toHaveCount(0);
      expect((await served(host!, projectPath)).pending_edits).toEqual([]);
    },
  );
});
