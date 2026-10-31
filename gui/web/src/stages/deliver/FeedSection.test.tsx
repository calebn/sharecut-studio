import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import type { FeedView, WriteRequest } from "../../types/feedView";
import { FeedLive } from "./FeedLive";
import { FeedSection } from "./FeedSection";
import {
  AGENT_PIN,
  CHECKS,
  CHOOSE_SHOW,
  DRIFTED,
  FIRST_RUN,
  PENDING,
  READY,
  STALE,
} from "./feedFixture";
import type { FeedAccess } from "./feedLogic";

function setup(
  first: FeedView = READY,
  extra: {
    request?: WriteRequest;
    state?: "ready" | "loading" | "error";
    access?: FeedAccess;
    problem?: string;
  } = {},
) {
  const onAction = vi.fn();
  const onOpenSource = vi.fn();
  const announce = vi.fn();
  useDawStore.setState({ announceStatus: announce });
  const user = userEvent.setup();
  const utils = render(
    <FeedLive
      view={first}
      {...extra}
      onAction={onAction}
      onOpenSource={onOpenSource}
    />,
  );
  return { ...utils, user, onAction, onOpenSource, announce };
}

const edit = (op: "set" | "unset", key: string, value?: string | boolean) => ({
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
    expect(onAction).toHaveBeenLastCalledWith({
      ...edit("set", "item.title", "Nobody asked the river live"),
      by: "person",
    });
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
      screen.getByRole("textbox", { name: "Edit episode hosting address" }),
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
      screen.getByRole("textbox", { name: "Edit episode hosting address" }),
    ).toHaveFocus();
  });

  it("hands commands and source jumps to the host", async () => {
    const { user, onAction, onOpenSource } = setup(CHECKS);
    await user.click(screen.getByText("Checks"));
    await user.click(screen.getByRole("button", { name: /^Choose artwork:/ }));
    expect(onAction).not.toHaveBeenCalled();
    await user.type(
      screen.getByRole("textbox", { name: "artwork address" }),
      "https://cdn.example.test/cover.jpg",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onAction).toHaveBeenCalledWith(
      edit("set", "channel.image", "https://cdn.example.test/cover.jpg"),
    );
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

  it("moves focus into the name field when New show opens", async () => {
    const { user } = setup(CHOOSE_SHOW);
    await user.click(screen.getByRole("button", { name: "New show" }));
    expect(screen.getByLabelText("Show name")).toHaveFocus();
  });

  it("offers Review only for a drift it can show", () => {
    const titleDrift: FeedView = {
      ...READY,
      item: {
        ...READY.item,
        "item.title": {
          value: "Mine",
          source: { kind: "pinned", by: "person", drifted: true },
        },
      },
      findings: [
        {
          key: "item.title",
          severity: "info",
          platform: null,
          message: "The auto value changed.",
          fix: null,
        },
      ],
    };
    setup(titleDrift);
    expect(screen.getByText("Check the episode title")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  });

  it("offers Review for drifted notes and it focuses Keep mine", async () => {
    const { user } = setup(DRIFTED);
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("button", { name: "Keep mine" })).toHaveFocus();
  });

  it("an undo of an agent's value goes back as the agent's", async () => {
    const { user, onAction } = setup(AGENT_PIN);
    await user.click(screen.getByRole("button", { name: /^A walk along/ }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "edit", by: "agent" }),
    );
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
    const first = setup(STALE, { request: "writing" });
    expect(screen.getByText("Writing the feed file.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Write" })).toBeNull();
    first.unmount();
    setup(STALE, { request: "failed" });
    expect(
      screen.getByText("Could not write the feed file."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("copies the notes the service rendered and confirms it", async () => {
    const { user, announce } = setup();
    await user.click(screen.getByRole("button", { name: "Copy notes" }));
    expect(await navigator.clipboard.readText()).toBe(READY.notesHtml);
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
    expect(screen.getByText("52m 0s").nextElementSibling).toBeNull();
  });

  it("has no a11y violations while writing or after a failed write", async () => {
    for (const request of ["writing", "failed"] as const) {
      const { container, unmount } = setup(STALE, { request });
      await expectNoA11yViolations(container);
      unmount();
    }
  });

  it("says Enter and Esc beside an open editor and ties it to the field", async () => {
    const { user } = setup();
    await user.click(title());
    expect(
      screen.getByRole("textbox", { name: "Edit episode title" }),
    ).toHaveAccessibleDescription("Enter to save, Esc to cancel");
  });

  it("keeps focus on the edited value after Keep mine", async () => {
    const { user } = setup(DRIFTED);
    await user.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(
      screen.getByRole("button", { name: /^Ana walks the old mill/ }),
    ).toHaveFocus();
  });

  it("moves focus to Undo after Use new, then to the restored notes after Undo", async () => {
    const { user } = setup(DRIFTED);
    await user.click(screen.getByRole("button", { name: "Use new" }));
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toHaveFocus();
    await user.click(undo);
    expect(
      screen.getByRole("button", { name: /^Ana walks the old mill/ }),
    ).toHaveFocus();
  });

  it("an edit shows in the XML pane and in the notes Copy notes sends", async () => {
    const { user } = setup(DRIFTED);
    await user.click(screen.getByRole("button", { name: "Keep mine" }));
    await user.click(screen.getByRole("button", { name: "Copy notes" }));
    expect(await navigator.clipboard.readText()).toContain(
      "19:40 Listener mail",
    );
    await user.click(screen.getByRole("button", { name: "XML" }));
    expect(screen.getByLabelText("Item XML")).toHaveTextContent(
      "19:40 Listener mail",
    );
  });

  it("names the show beside the episode from the channel", () => {
    setup();
    expect(screen.getByText("The Long River")).toBeInTheDocument();
  });

  it("says it is loading while the skeleton shows", () => {
    const { container } = setup(READY, { state: "loading" });
    expect(screen.getByText("Loading the listing")).toHaveAttribute(
      "role",
      "status",
    );
    expect(container.querySelector(".sys-skeleton")).not.toBeNull();
  });

  describe("by access", () => {
    it("lets the host see no access note", () => {
      setup(READY);
      expect(screen.queryByText(/You can edit this listing/)).toBeNull();
      expect(screen.queryByText(/can read the listing/)).toBeNull();
    });

    it("lets an Editor edit and write, and leaves the show to the host", async () => {
      const { user } = setup(CHOOSE_SHOW, { access: "editor" });
      expect(screen.getByText(/You can edit this listing/)).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", {
          name: "Which show is this episode in?",
        }),
      ).toBeNull();
      expect(
        screen.getByText("The host picks which show this episode is in."),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New show" })).toBeNull();
      await user.click(title());
      expect(
        screen.getByRole("textbox", { name: "Edit episode title" }),
      ).toBeInTheDocument();
      await user.keyboard("{Escape}");
    });

    it("lets an Editor set the episode's own hosting address", async () => {
      const { user, onAction } = setup(PENDING, { access: "editor" });
      await user.click(screen.getByRole("button", { name: "Add address" }));
      await user.keyboard("https://cdn.example.test/ep.mp3{Enter}");
      expect(onAction).toHaveBeenCalledWith(
        edit("set", "item.enclosure.url", "https://cdn.example.test/ep.mp3"),
      );
    });

    it("lets an Editor write the feed file", async () => {
      const { user, onAction } = setup(STALE, { access: "editor" });
      await user.click(screen.getByRole("button", { name: "Write" }));
      expect(onAction).toHaveBeenCalledWith({
        kind: "command",
        command: "write_feed",
      });
    });

    it("keeps host-only fixes disabled with the reason for an Editor", async () => {
      const { user, onAction } = setup(FIRST_RUN, { access: "editor" });
      await user.click(screen.getByText("Checks"));
      const create = screen.getAllByRole("button", {
        name: /^Set up your show:/,
      })[0];
      expect(create).toBeDisabled();
      expect(create).toHaveAttribute("title", "Only the host can change this.");
      expect(onAction).not.toHaveBeenCalled();
    });

    it("asks for a yes or no with a choice and the field's label", async () => {
      const { user, onAction } = setup(
        {
          ...CHECKS,
          findings: [
            {
              key: "channel.explicit",
              severity: "warn",
              platform: "Apple",
              message: "Apple needs to know if the show is explicit.",
              fix: { kind: "input", key: "channel.explicit" },
            },
          ],
        },
        { access: "host" },
      );
      await user.click(screen.getByText("Checks"));
      await user.click(
        screen.getByRole("button", { name: /^Say if it is explicit:/ }),
      );
      await user.selectOptions(
        screen.getByRole("combobox", { name: "explicit content" }),
        "yes",
      );
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(onAction).toHaveBeenCalledWith(
        edit("set", "channel.explicit", true),
      );
    });

    it("offers only Yes for a flag the service accepts only switched on", async () => {
      const { user } = setup(
        {
          ...CHECKS,
          findings: [
            {
              key: "channel.block",
              severity: "warn",
              platform: "Apple",
              message: "Choose whether to hide the show.",
              fix: { kind: "input", key: "channel.block" },
            },
          ],
        },
        { access: "editor" },
      );
      await user.click(screen.getByText("Checks"));
      await user.click(
        screen.getByRole("button", {
          name: /^Choose whether to hide the show:/,
        }),
      );
      const choice = screen.getByRole("combobox", {
        name: "hide from directories",
      });
      expect(
        within(choice)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["Choose", "Yes"]);
    });

    it("asks an Editor for artwork as an https address only", async () => {
      const { user, onAction } = setup(CHECKS, { access: "editor" });
      await user.click(screen.getByText("Checks"));
      await user.click(
        screen.getByRole("button", { name: /^Choose artwork:/ }),
      );
      const field = screen.getByRole("textbox", { name: "artwork address" });
      await user.type(field, "/Users/ana/cover.jpg");
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      expect(
        screen.getAllByText(
          "An edit link can set artwork only as an https address.",
        ).length,
      ).toBeGreaterThan(0);
      await user.clear(field);
      await user.type(field, "https://cdn.example.test/cover.jpg");
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(onAction).toHaveBeenCalledWith(
        edit("set", "channel.image", "https://cdn.example.test/cover.jpg"),
      );
    });

    it("gives the Guest mark its explanation as text, not a focus stop", () => {
      const guest: FeedView = {
        ...READY,
        item: {
          ...READY.item,
          "item.title": {
            value: "Guest title",
            source: { kind: "pinned", by: "guest", drifted: false },
          },
        },
      };
      setup(guest, { access: "editor" });
      const mark = screen.getByTitle("Set with an edit link");
      expect(mark).not.toHaveAttribute("tabindex");
      expect(mark).toHaveTextContent("Guest, Set with an edit link");
    });

    it("marks a value a guest wrote", () => {
      const guest: FeedView = {
        ...READY,
        item: {
          ...READY.item,
          "item.title": {
            value: "Guest title",
            source: { kind: "pinned", by: "guest", drifted: false },
          },
        },
      };
      setup(guest, { access: "editor" });
      expect(screen.getByTitle("Set with an edit link")).toHaveTextContent(
        /^Guest/,
      );
    });

    it("reads only for a Viewer or Commenter link", async () => {
      const { user, onAction } = setup(
        { ...DRIFTED, file: "stale" },
        { access: "viewer" },
      );
      expect(screen.getByText(/can read the listing/)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Nobody asked the river" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Keep mine" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Use new" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Write" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Edit chapters" }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Copy notes" }),
      ).toBeInTheDocument();
      await user.click(screen.getByText("Checks"));
      expect(screen.queryByRole("button", { name: /^Choose/ })).toBeNull();
      expect(onAction).not.toHaveBeenCalled();
    });

    it("says why the listing did not load and offers another try", async () => {
      const onRetry = vi.fn();
      const user = userEvent.setup();
      render(
        <FeedSection
          view={READY}
          itemXml=""
          state="error"
          problem="Couldn't reach the server. Check your connection and try again."
          onRetry={onRetry}
          onAction={vi.fn()}
          onOpenSource={vi.fn()}
        />,
      );
      expect(screen.getByText(/Couldn't reach the server/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(onRetry).toHaveBeenCalled();
    });

    it("shows a refused action in plain words and lets it be dismissed", async () => {
      const onDismiss = vi.fn();
      const user = userEvent.setup();
      render(
        <FeedSection
          view={READY}
          itemXml=""
          problem="That setting is changed by the host."
          onDismissProblem={onDismiss}
          onAction={vi.fn()}
          onOpenSource={vi.fn()}
        />,
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That setting is changed by the host.",
      );
      await user.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(onDismiss).toHaveBeenCalled();
    });

    it("says the feed file was written once the write comes back", () => {
      const { rerender } = render(
        <FeedSection
          view={STALE}
          itemXml=""
          request="writing"
          onAction={vi.fn()}
          onOpenSource={vi.fn()}
        />,
      );
      rerender(
        <FeedSection
          view={READY}
          itemXml=""
          onAction={vi.fn()}
          onOpenSource={vi.fn()}
        />,
      );
      expect(screen.getByText("Wrote the feed file.")).toBeInTheDocument();
    });
  });

  describe("the feed file row", () => {
    const feedFile = {
      id: "ep.feed.xml",
      name: "ep.feed.xml",
      kind: "feed",
      label: "Feed file",
      bytes: 2048,
      current: true,
    } as const;

    it("shows the feed file the folder holds, as a download", () => {
      render(
        <FeedSection
          view={READY}
          itemXml=""
          files={{
            files: [{ ...feedFile, href: "/api/export/files/ep.feed.xml" }],
            access: "download",
            running: false,
          }}
          onAction={vi.fn()}
          onOpenSource={vi.fn()}
        />,
      );
      const link = screen.getByRole("link", {
        name: /^Download ep\.feed\.xml/,
      });
      expect(link).toHaveAttribute("href", "/api/export/files/ep.feed.xml");
    });

    it("shows no row without the host's files", () => {
      render(
        <FeedSection
          view={READY}
          itemXml=""
          onAction={vi.fn()}
          onOpenSource={vi.fn()}
        />,
      );
      expect(screen.queryByText("ep.feed.xml")).toBeNull();
    });
  });
});
