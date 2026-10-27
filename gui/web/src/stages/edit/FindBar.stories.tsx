import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState } from "react";
import { expect, userEvent, within } from "storybook/test";
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
import { findMatches } from "./findMatches";
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
          "Find and replace (spec CMP-FINDREPLACE): a 44 px bar under the Script header with the Find field, its count (\"3 of 12\"), previous and next, a Match case toggle, a Replace toggle that opens a second row with Replace and All, and two verbs for the common case, Select all and Cut all. Matches take a tint in the text and the current one an outline. Enter and Down step to the next hit, Up to the previous one, Shift+Enter cuts all hits as one undo step, and Esc closes from anywhere in the bar. A reader who cannot edit gets no Replace.\n\nMod+F belongs to the host: it opens the bar, and when the bar is open it calls the handle's `focus()`. The bar takes focus when it mounts, and the host puts focus back on the header's Find button when it closes. The host also matches the query (`findMatches`), passes the hits to the pane as `matches` and `currentMatch`, and scrolls the current one into view.\n\n**Motion.** None.",
      },
    },
  },
};

export default meta;
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
  const wasOpen = useRef(open);
  const matches = findMatches(turns, query, caseSensitive);
  const at = matches.length === 0 ? -1 : Math.min(current, matches.length - 1);
  const { pane: live } = useLiveScript({
    turns,
    onFind: () => (bar.current ? bar.current.focus() : setOpen(true)),
  });

  useEffect(() => {
    if (wasOpen.current && !open) {
      host.current
        ?.querySelector<HTMLElement>("button[aria-label='Find in transcript']")
        ?.focus();
    }
    wasOpen.current = open;
  }, [open]);

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
    setTurns((now) =>
      [...matches]
        .reverse()
        .reduce((all, m) => replaceSpan(all, m, replaceText), [...now]),
    );
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
    await expect(canvas.getByText("1 of 2")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "room (current match)" }),
    ).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByText("2 of 2")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "room (match)" }),
    ).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByText("1 of 2")).toBeVisible();
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
    await expect(canvas.getByText("1 of 1")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Replace all" }));
    await expect(canvas.getByText("No matches")).toBeVisible();
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
    await expect(canvas.getByText("No matches")).toBeVisible();
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
    await expect(canvas.queryByText("1 of 2")).toBeNull();
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
