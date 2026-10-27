import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SRC_ROOT } from "../test/sourceFiles";
import { NotesRail, type NotesRailProps } from "./NotesRail";
import type { NoteItem } from "./notesRailModel";

const ITEMS: NoteItem[] = [
  {
    id: "m1",
    kind: "marker",
    author: { name: "Rosa Diaz", colorIndex: 2 },
    time: "12:01",
  },
  {
    id: "n1",
    kind: "note",
    author: { name: "Maya Chen" },
    text: "Keep the laugh",
    time: "12:04",
    visibility: "everyone",
  },
  {
    id: "n2",
    kind: "note",
    author: { name: "Rosa Diaz" },
    text: "Jon's level is low",
    time: "12:06",
    visibility: "hosts",
  },
  {
    id: "n3",
    kind: "note",
    author: { name: "Maya Chen" },
    text: "Cold open first",
    time: null,
    visibility: "everyone",
  },
];

function setup(over: Partial<NotesRailProps> = {}) {
  const props: NotesRailProps = {
    items: ITEMS,
    viewer: "host",
    selfName: "Maya Chen",
    draft: "",
    onDraftChange: vi.fn(),
    draftTime: "12:08",
    onClearTime: vi.fn(),
    everyone: false,
    onEveryoneChange: vi.fn(),
    onSend: vi.fn(),
    ...over,
  };
  const utils = render(<NotesRail {...props} />);
  return { ...utils, props };
}

const field = () => screen.getByRole("textbox", { name: "Add a note" });
const send = () => screen.getByRole("button", { name: "Send note" });

describe("NotesRail", () => {
  it("is a labelled Notes landmark", () => {
    setup();
    expect(screen.getByRole("region", { name: "Notes" })).toBeInTheDocument();
  });

  it("lists markers and notes chronologically as rows, with no live region", () => {
    setup();
    const list = screen.getByRole("list");
    expect(list).not.toHaveAttribute("aria-live");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    // The session-level note lands first.
    expect(rows[0]).toHaveTextContent("Cold open first");
    expect(rows[1]).toHaveTextContent("Marker");
    expect(rows[3]).toHaveTextContent("Jon's level is low");
  });

  it("gives a session-level note no time and reads it as one", () => {
    setup();
    expect(
      screen.getByRole("button", { name: /Cold open first.*session note/ }),
    ).toBeInTheDocument();
  });

  it("marks a hosts-only note as restricted in its row name", () => {
    setup();
    expect(
      screen.getByRole("button", {
        name: /Jon's level is low.*Host and producers only/,
      }),
    ).toBeInTheDocument();
  });

  it("gives the full note text as the snippet's title", () => {
    setup();
    expect(screen.getByTitle("Keep the laugh")).toBeInTheDocument();
  });

  it("shows the empty line when a guest sees nothing", () => {
    setup({ items: [], viewer: "guest" });
    expect(
      screen.getByText("No notes yet. Notes pin to the recording time."),
    ).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("hides a hosts-only note from a guest who did not write it", () => {
    setup({ viewer: "guest", selfName: "Sam" });
    expect(screen.queryByText("Jon's level is low")).toBeNull();
    expect(screen.getByText("Keep the laugh")).toBeVisible();
  });

  it("shows the paused line under the list and keeps the composer", () => {
    setup({ paused: true });
    expect(screen.getByText("Paused. Notes land at the pause.")).toBeVisible();
    expect(field()).toBeEnabled();
  });

  it("sends the trimmed text, the pinned time and the everyone choice on Enter", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    setup({ draft: "  Is this dead air?  ", everyone: true, onSend });
    field().focus();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith({
      text: "Is this dead air?",
      time: "12:08",
      everyone: true,
    });
  });

  it("keeps Shift+Enter as a newline and does not send", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    setup({ draft: "a", onSend });
    field().focus();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send during IME composition", () => {
    const onSend = vi.fn();
    setup({ draft: "ni", onSend });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send on keyCode 229, the IME's own keydown", () => {
    const onSend = vi.fn();
    setup({ draft: "ni", onSend });
    fireEvent.keyDown(field(), { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends from the button when the draft has words", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    setup({ draft: "Keep it", draftTime: null, onSend });
    await user.click(send());
    expect(onSend).toHaveBeenCalledWith({
      text: "Keep it",
      time: null,
      everyone: false,
    });
  });

  it("keeps an empty send off and says why, without sending", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    setup({ draft: "   ", onSend });
    expect(send()).toHaveAttribute("aria-disabled", "true");
    expect(send()).toHaveAttribute("title", "Write a note to send");
    expect(screen.getByText("Write a note to send")).toBeVisible();
    await user.click(send());
    field().focus();
    await user.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clears the pinned time through a labelled button", async () => {
    const user = userEvent.setup();
    const onClearTime = vi.fn();
    setup({ onClearTime });
    expect(screen.getByText("12:08")).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "12:08, clear time to make this a session note",
      }),
    );
    expect(onClearTime).toHaveBeenCalledOnce();
    // The chip unmounts once the time is gone, so focus lands in the field.
    expect(field()).toHaveFocus();
  });

  it("shows no time chip when the draft is a session-level note", () => {
    setup({ draftTime: null });
    expect(screen.queryByRole("button", { name: /clear time/ })).toBeNull();
  });

  it("shows the Everyone toggle only when the caller can widen a note", async () => {
    const user = userEvent.setup();
    const onEveryoneChange = vi.fn();
    const { unmount } = setup({ onEveryoneChange, everyone: false });
    const toggle = screen.getByRole("button", { name: "Everyone" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(onEveryoneChange).toHaveBeenCalledWith(true);
    unmount();
    setup({ onEveryoneChange: undefined });
    expect(screen.queryByRole("button", { name: "Everyone" })).toBeNull();
  });

  it("keeps the composer label and placeholder on one field", () => {
    setup();
    expect(field()).toHaveAttribute("placeholder", "Add a note");
  });

  it("keeps the send rule in the record stylesheet and the lock rule in the review one", () => {
    const record = readFileSync(
      join(SRC_ROOT, "styles/partials/system-record.css"),
      "utf8",
    );
    const review = readFileSync(
      join(SRC_ROOT, "styles/partials/system-review.css"),
      "utf8",
    );
    expect(record).toMatch(/\.sys-notes-send\b/);
    expect(review).toMatch(/\.sys-queue-restricted\s*\{/);
  });
});
