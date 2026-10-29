import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { FeedLive } from "./FeedLive";
import {
  AGENT_PIN,
  CHECKS,
  CHOOSE_SHOW,
  DRIFTED,
  FIRST_RUN,
  ITEM_XML,
  NOTES_HTML,
  PENDING,
  READY,
  STALE,
  WRITE_FAILED,
  WRITING,
} from "./feedFixture";
import type { FeedView } from "./feedView";

function setup(first: FeedView = READY) {
  const onAction = vi.fn();
  const onOpenSource = vi.fn();
  const announce = vi.fn();
  useDawStore.setState({ announceStatus: announce });
  const user = userEvent.setup();
  const utils = render(
    <FeedLive
      view={first}
      itemXml={ITEM_XML}
      onAction={onAction}
      onOpenSource={onOpenSource}
    />,
  );
  return { ...utils, user, onAction, onOpenSource, announce };
}

const edit = (op: "set" | "unset", key: string, value?: string) => ({
  kind: "edit",
  edit: op === "set" ? { op, key, value } : { op, key },
});

const title = () =>
  screen.getByRole("button", { name: "Nobody asked the river" });

describe("FeedSection", () => {
  it("has no a11y violations in each state", async () => {
    for (const view of [
      READY,
      PENDING,
      CHECKS,
      DRIFTED,
      FIRST_RUN,
      CHOOSE_SHOW,
      AGENT_PIN,
      WRITING,
      WRITE_FAILED,
    ]) {
      const { container, unmount } = setup(view);
      await expectNoA11yViolations(container);
      unmount();
    }
  });

  it("Enter commits a pin and swaps the Auto mark for Edited", async () => {
    const { user, onAction } = setup();
    expect(screen.getByText("Auto")).toBeInTheDocument();
    await user.click(title());
    await user.keyboard("{End} live{Enter}");
    expect(onAction).toHaveBeenCalledExactlyOnceWith(
      edit("set", "item.title", "Nobody asked the river live"),
    );
    expect(
      screen.getByRole("button", { name: "Nobody asked the river live" }),
    ).toHaveFocus();
    expect(screen.queryByText("Auto")).toBeNull();
    expect(screen.getAllByText("Edited").length).toBeGreaterThan(0);
  });

  it("Escape cancels without an edit and returns focus", async () => {
    const { user, onAction } = setup();
    await user.click(title());
    await user.keyboard("zzz{Escape}");
    expect(onAction).not.toHaveBeenCalled();
    expect(title()).toHaveFocus();
  });

  it("Use auto hands the title back and Undo puts the typed text back", async () => {
    const { user, onAction, announce } = setup();
    await user.click(title());
    await user.keyboard("{End} live{Enter}");
    await user.click(
      screen.getByRole("button", { name: "Nobody asked the river live" }),
    );
    await user.click(screen.getByRole("button", { name: "Use auto" }));
    expect(onAction).toHaveBeenLastCalledWith(edit("unset", "item.title"));
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Auto")).toBeInTheDocument();
    expect(
      screen.getByText("Your episode title is back to auto."),
    ).toBeInTheDocument();
    expect(announce).toHaveBeenCalledWith(
      "Your episode title is back to auto.",
      { toast: false },
    );
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAction).toHaveBeenLastCalledWith(
      edit("set", "item.title", "Nobody asked the river live"),
    );
    expect(
      screen.getByRole("button", { name: "Nobody asked the river live" }),
    ).toBeInTheDocument();
  });

  it("emptying a pinned value hands it back with Undo", async () => {
    const { user, onAction } = setup();
    await user.click(
      screen.getByRole("button", { name: /^Ana walks the old mill/ }),
    );
    await user.clear(
      screen.getByRole("textbox", { name: "Edit episode intro" }),
    );
    await user.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledWith(edit("unset", "item.intro"));
    expect(screen.getByText("Cleared the episode intro.")).toBeInTheDocument();
  });

  it("Done commits and closes the editor", async () => {
    const { user, onAction } = setup();
    await user.click(title());
    await user.keyboard("!");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onAction).toHaveBeenCalledWith(
      edit("set", "item.title", "Nobody asked the river!"),
    );
    expect(
      screen.queryByRole("textbox", { name: "Edit episode title" }),
    ).toBeNull();
  });

  it("the strip button is the one fix button and it opens the value", async () => {
    const { user, onAction } = setup(PENDING);
    expect(screen.getByText("2 things left")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "Add address" });
    expect(buttons).toHaveLength(1);
    expect(
      screen.queryAllByRole("button", { name: "Export episode" }),
    ).toHaveLength(0);
    await user.click(buttons[0]);
    expect(
      screen.getByRole("textbox", { name: "Edit hosting address" }),
    ).toHaveFocus();
    await user.keyboard("https://cdn.example.test/a.mp3{Enter}");
    expect(onAction).toHaveBeenCalledExactlyOnceWith(
      edit("set", "item.enclosure.url", "https://cdn.example.test/a.mp3"),
    );
    expect(screen.getByText("1 thing left")).toBeInTheDocument();
  });

  it("the pending sentence is itself a way in to the value", async () => {
    const { user } = setup(PENDING);
    await user.click(
      screen.getByRole("button", { name: "Where will this be hosted?" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Edit hosting address" }),
    ).toHaveFocus();
  });

  it("hands commands and source jumps to the host", async () => {
    const { user, onAction, onOpenSource } = setup(CHECKS);
    await user.click(screen.getByText("Checks"));
    await user.click(screen.getByRole("button", { name: /^Choose artwork:/ }));
    expect(onAction).toHaveBeenCalledWith({
      kind: "command",
      command: "choose_art",
    });
    await user.click(screen.getByRole("button", { name: "Edit chapters" }));
    expect(onOpenSource).toHaveBeenCalledWith("chapters");
    await user.click(
      screen.getByRole("button", { name: "2 soundbites. Open clips" }),
    );
    expect(onOpenSource).toHaveBeenCalledWith("clips");
    expect(
      screen.getByRole("button", {
        name: "Transcript SRT · VTT. Open transcript",
      }),
    ).toBeInTheDocument();
  });

  it("Keep mine re-pins the same text and clears the drift", async () => {
    const { user, onAction } = setup(DRIFTED);
    expect(screen.queryByText("Ready to publish")).toBeNull();
    expect(screen.getByText("Check the notes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep mine" }));
    const [call] = onAction.mock.calls[0];
    expect(call).toMatchObject({
      kind: "edit",
      edit: { op: "set", key: "item.notes" },
    });
    expect(call.edit.value).toContain("19:40 Listener mail");
    expect(screen.queryByText(/changed since you edited/)).toBeNull();
    expect(screen.getByText("Ready to publish")).toBeInTheDocument();
  });

  it("says what changed when the view supplies it", () => {
    setup(DRIFTED);
    expect(
      screen.getByText(/Listener mail.{1,4}is now.{1,4}What the river wanted/),
    ).toBeInTheDocument();
  });

  it("Use new hands the pin back, shows the live notes, and Undo restores it", async () => {
    const { user, onAction } = setup(DRIFTED);
    await user.click(screen.getByRole("button", { name: "Use new" }));
    expect(onAction).toHaveBeenCalledWith(edit("unset", "item.notes"));
    expect(screen.getByText("What the river wanted")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        edit: expect.objectContaining({ op: "set", key: "item.notes" }),
      }),
    );
    expect(screen.getByText(/19:40 Listener mail/)).toBeInTheDocument();
  });

  it("creates the show from the name alone with one command", async () => {
    const { user, onAction } = setup(FIRST_RUN);
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(screen.getByText("Name your show to create it.")).toBeVisible();
    await user.type(
      screen.getByLabelText("Show name"),
      "The Long River{Enter}",
    );
    expect(onAction).toHaveBeenCalledExactlyOnceWith({
      kind: "command",
      command: "create_show",
      args: { title: "The Long River" },
    });
  });

  it("the show fix focuses the name field", async () => {
    const { user } = setup(FIRST_RUN);
    await user.click(screen.getByRole("button", { name: "Set up your show" }));
    expect(screen.getByLabelText("Show name")).toHaveFocus();
  });

  it("links one of the shows you have", async () => {
    const { user, onAction } = setup(CHOOSE_SHOW);
    await user.click(screen.getByRole("button", { name: "Field Notes" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith({
      kind: "command",
      command: "link_show",
      args: { id: "field-notes" },
    });
  });

  it("blocks Copy feed item and Write and says why in view", () => {
    setup(CHECKS);
    const copy = screen.getByRole("button", { name: "Copy feed item" });
    const write = screen.getByRole("button", { name: "Write feed file" });
    expect(copy).toBeDisabled();
    expect(write).toBeDisabled();
    const note = screen.getByText("Fix the blocker first.", { selector: "p" });
    expect(note).toBeVisible();
    expect(copy).toHaveAccessibleDescription("Fix the blocker first.");
  });

  it("writes a stale file through one command", async () => {
    const { user, onAction } = setup(STALE);
    expect(screen.getByText("Feed file is out of date.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Write" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith({
      kind: "command",
      command: "write_feed",
    });
    expect(screen.getByText("Feed file is up to date.")).toBeInTheDocument();
  });

  it("shows a write in progress and a failed write with a way to retry", () => {
    const first = setup(WRITING);
    expect(screen.getByText("Writing the feed file.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Write" })).toBeNull();
    first.unmount();
    setup(WRITE_FAILED);
    expect(
      screen.getByText("Could not write the feed file."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("copies the notes the service rendered and confirms it", async () => {
    const { user, announce } = setup();
    await user.click(screen.getByRole("button", { name: "Copy notes" }));
    expect(await navigator.clipboard.readText()).toBe(NOTES_HTML);
    expect(await screen.findByText("Copied notes")).toBeInTheDocument();
    expect(announce).toHaveBeenCalledWith("Copied notes", { toast: false });
  });

  it("shows the item XML with CDATA text left as content", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "XML" }));
    const xml = screen.getByLabelText("Item XML");
    expect(xml).toHaveTextContent(
      '<enclosure url="https://cdn.example.test/long-river/ep-12.mp3"',
    );
    const inCdata = screen.getByText(/^<p>Ana walks/);
    expect(inCdata).not.toHaveClass("fd-xml-tag");
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("an agent pin says Agent until a person edits it", async () => {
    const { user } = setup(AGENT_PIN);
    expect(screen.getByText("Agent")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^A walk along/ }));
    await user.keyboard(" Listen.{Enter}");
    expect(screen.queryByText("Agent")).toBeNull();
  });

  it("marks inherited art and a minted id, and a measured length carries no mark", () => {
    setup();
    expect(screen.getByText("From your show")).toBeInTheDocument();
    expect(
      screen.getByText("Assigned Oct 23, 2026. It never changes."),
    ).toBeInTheDocument();
    expect(screen.getByText("52 min").nextElementSibling).toBeNull();
  });
});
