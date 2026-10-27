import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { ScriptPane, type ScriptPaneHandle } from "../../system/ScriptPane";
import {
  cutMark,
  patchWords,
  replaceSpan,
  SCRIPT_TURNS,
  spanPatch,
} from "../../system/scriptFixtures";
import type { ScriptTurn } from "../../system/scriptPieces";
import { FindBar, type FindBarHandle } from "./FindBar";
import { findCountText, findMatches } from "./findMatches";
import { scriptFrame, useLiveScript } from "./scriptDemo";

type SurfaceProps = {
  query?: string;
  replaceOpen?: boolean;
  replaceText?: string;
  phone?: boolean;
  guest?: boolean;
};

const meta: Meta<SurfaceProps> = {
  title: "Stages/Edit/FindBar",
  tags: ["autodocs"],
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "Find and replace (spec CMP-FINDREPLACE): a 44 px bar under the Script header with the Find field, its count (\"3 of 12\"), previous and next, a Match case toggle, a Replace toggle that opens a second row with Replace and All, and two verbs for the common case, Select all and Cut all. Matches take a tint in the text and the current one an outline.\n\nKeys, in the Find field. Enter and Down step to the next hit, Shift+Enter and Up to the previous one, Mod+Shift+Enter (Ctrl or Cmd) cuts all hits as one undo step, and Esc closes from anywhere in the bar. Cut all also has its own button. In the Replace field Enter replaces the current hit. Replace and All wait until the replacement has a letter or a number, as the backend requires. A reader who cannot edit gets no Replace.\n\nMatching is the backend's: whole words, edge punctuation ignored, case folded, muted and already-cut words skipped (`findMatches`). The bar takes `busy`, `error` and `maxLength` (500) so a slow or refused request has somewhere to show.\n\nMod+F belongs to the host: it opens the bar, and when the bar is open it calls the handle's `focus()`. The count is plain text; the pane's one live region speaks it through `findStatus`. When the bar closes, and after Cut all or Replace all settle, the bar calls `returnFocus`, which the host points at the pane handle's `focusFind()`. The host also passes the hits to the pane as `matches` and `currentMatch` and scrolls the current one into view. Replace all returns how many it replaced, for the host's \"Replaced 12 · Undo\" toast.\n\n**Motion.** None.",
      },
    },
  },
};

export default meta;

/** The bar's own count; the pane's live region repeats it for screen readers. */
const shownCount = (root: HTMLElement) => {
  const el = root.querySelector<HTMLElement>(".sys-edit-find-count");
  if (!el) throw new Error("No Find bar count");
  return el;
};
type Story = StoryObj<SurfaceProps>;

function Surface({
  query: first = "",
  replaceOpen: replaceFirst = false,
  replaceText: textFirst = "",
  phone = false,
  guest = false,
}: SurfaceProps) {
  const [turns, setTurns] = useState<readonly ScriptTurn[]>(SCRIPT_TURNS);
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState(first);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(0);
  const [replaceOpen, setReplaceOpen] = useState(replaceFirst);
  const [replaceText, setReplaceText] = useState(textFirst);
  const pane = useRef<ScriptPaneHandle>(null);
  const bar = useRef<FindBarHandle>(null);
  const host = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState("");
  const matches = findMatches(turns, query, caseSensitive);
  const at = matches.length === 0 ? -1 : Math.min(current, matches.length - 1);
  const { pane: live } = useLiveScript({
    turns,
    onFind: () => (bar.current ? bar.current.focus() : setOpen(true)),
  });

  const go = (to: number) => {
    if (matches.length === 0) return;
    const next = (to + matches.length) % matches.length;
    setCurrent(next);
    pane.current?.scrollToWord(matches[next].start, "center");
  };
  const cutAll = () => {
    setTurns((now) =>
      patchWords(
        now,
        Object.assign(
          {},
          ...matches.map((m, i) =>
            spanPatch(m.start, m.end, { mark: cutMark(`find-${i}`, 0.4) }),
          ),
        ),
      ),
    );
    setQuery("");
  };
  const replaceAll = () => {
    const count = matches.length;
    setTurns((now) =>
      [...matches]
        .reverse()
        .reduce((all, m) => replaceSpan(all, m, replaceText), [...now]),
    );
    setNotice(`Replaced ${count} · Undo`);
    return count;
  };

  return (
    <div ref={host} style={scriptFrame(phone ? "22.5rem" : "32rem")}>
      <ScriptPane
        {...live}
        ref={pane}
        layout={phone ? "phone" : "desktop"}
        guest={guest ? "viewer" : undefined}
        matches={open ? matches : undefined}
        currentMatch={at}
        findStatus={open ? findCountText(query, matches.length, at) : undefined}
        findBar={
          open ? (
            <FindBar
              ref={bar}
              query={query}
              onQueryChange={(next) => {
                setQuery(next);
                setCurrent(0);
              }}
              caseSensitive={caseSensitive}
              onCaseSensitiveChange={setCaseSensitive}
              count={matches.length}
              current={at}
              onNext={() => go(at + 1)}
              onPrevious={() => go(at - 1)}
              onClose={() => setOpen(false)}
              returnFocus={() => pane.current?.focusFind()}
              onCutAll={guest ? undefined : cutAll}
              onSelectAll={() => {
                const [first, ...rest] = matches;
                if (first) {
                  live.onSelect?.({
                    kind: "words",
                    anchor: first.start,
                    head: (rest.at(-1) ?? first).end,
                  });
                }
              }}
              replace={
                guest
                  ? undefined
                  : {
                      open: replaceOpen,
                      onOpenChange: setReplaceOpen,
                      text: replaceText,
                      onTextChange: setReplaceText,
                      onReplace: () => {
                        const hit = matches[at];
                        if (hit) setTurns(replaceSpan(turns, hit, replaceText));
                      },
                      onReplaceAll: replaceAll,
                    }
              }
            />
          ) : null
        }
      />
      {notice ? <p data-notice>{notice}</p> : null}
    </div>
  );
}

const render: Story["render"] = (args) => <Surface {...args} />;

export const Find: Story = {
  render,
  args: { query: "room" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("searchbox", { name: "Find" })).toHaveFocus();
    await expect(shownCount(canvasElement)).toHaveTextContent("1 of 2");
    await expect(
      canvas.getByRole("button", { name: "room (current match)" }),
    ).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect(shownCount(canvasElement)).toHaveTextContent("2 of 2");
    await expect(
      canvas.getByRole("button", { name: "room (match)" }),
    ).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect(shownCount(canvasElement)).toHaveTextContent("1 of 2");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await expect(shownCount(canvasElement)).toHaveTextContent("2 of 2");
    await expect(canvas.getByRole("status")).toHaveTextContent("2 of 2");
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("search")).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Find in transcript" }),
    ).toHaveFocus();
  },
};

export const FindReplace: Story = {
  render,
  args: { query: "room", replaceOpen: true, replaceText: "space" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Replace" }));
    await expect(canvas.getByRole("button", { name: "space" })).toBeVisible();
    await expect(shownCount(canvasElement)).toHaveTextContent("1 of 1");
    await userEvent.click(canvas.getByRole("button", { name: "Replace all" }));
    await expect(shownCount(canvasElement)).toHaveTextContent("No matches");
    await expect(
      canvasElement.querySelector("[data-notice]"),
    ).toHaveTextContent("Replaced 1 · Undo");
    await expect(canvas.getAllByRole("button", { name: "space" })).toHaveLength(
      2,
    );
  },
};

export const NoMatches: Story = {
  render,
  args: { query: "zzz" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(shownCount(canvasElement)).toHaveTextContent("No matches");
    await expect(
      canvas.getByRole("button", { name: "Next match" }),
    ).toBeDisabled();
    await expect(canvas.queryByRole("button", { name: /^Cut all/ })).toBeNull();
  },
};

export const CutAll: Story = {
  render,
  args: { query: "room" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Cut all 2" }));
    await expect(
      canvas.getAllByRole("button", { name: "Cut, 0.4 s removed" }),
    ).toHaveLength(2);
    await expect(shownCount(canvasElement)).not.toHaveTextContent("1 of 2");
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Find in transcript" }),
      ).toHaveFocus(),
    );
  },
};

export const Phone: Story = {
  render,
  args: { query: "the", phone: true, replaceOpen: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("searchbox", { name: "Find" })).toBeVisible();
    await expect(
      canvas.getByRole("textbox", { name: "Replace with" }),
    ).toBeVisible();
  },
};

export const GuestCannotReplace: Story = {
  render,
  args: { query: "room", guest: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: "Show replace" }),
    ).toBeNull();
    await expect(canvas.queryByRole("button", { name: /^Cut all/ })).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Select all 2" }),
    ).toBeVisible();
  },
};

export const CutWordsAreSkipped: Story = {
  render,
  args: { query: "room" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Cut all 2" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Find in transcript" }),
    );
    await userEvent.keyboard("room");
    await expect(shownCount(canvasElement)).toHaveTextContent("No matches");
    await expect(canvas.queryByRole("button", { name: /^Cut all/ })).toBeNull();
  },
};

export const CutAllByKeyboard: Story = {
  render,
  args: { query: "room" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    await expect(
      canvas.getAllByRole("button", { name: "Cut, 0.4 s removed" }),
    ).toHaveLength(2);
  },
};

export const NeedsAReplacement: Story = {
  render,
  args: { query: "room", replaceOpen: true, replaceText: "" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Replace" }),
    ).toBeDisabled();
    await expect(
      canvas.getByRole("button", { name: "Replace all" }),
    ).toBeDisabled();
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Replace with" }),
      "space",
    );
    await expect(canvas.getByRole("button", { name: "Replace" })).toBeEnabled();
  },
};
