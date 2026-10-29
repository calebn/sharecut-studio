import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { FeedSection } from "./FeedSection";
import {
  AGENT_PIN,
  applyEdit,
  CHECKS,
  DRIFTED,
  FIRST_RUN,
  ITEM_XML,
  PENDING,
  READY,
  STALE,
} from "./feedFixture";
import type { FeedView } from "./feedView";

function setup(first: FeedView = READY) {
  const calls = {
    onEdit: vi.fn(),
    onCreateShow: vi.fn(),
    onFix: vi.fn(),
    onOpenSource: vi.fn(),
    onCopyNotes: vi.fn(),
    onCopyItem: vi.fn(),
    onWrite: vi.fn(),
  };
  function Host() {
    const [view, setView] = useState(first);
    return (
      <FeedSection
        {...calls}
        view={view}
        itemXml={ITEM_XML}
        onEdit={(edit) => {
          calls.onEdit(edit);
          setView((now) => applyEdit(now, edit));
        }}
      />
    );
  }
  const utils = render(<Host />);
  return { ...utils, ...calls, user: userEvent.setup() };
}

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
      AGENT_PIN,
    ]) {
      const { container, unmount } = setup(view);
      await expectNoA11yViolations(container);
      unmount();
    }
  });

  it("Enter commits a pin and drops the Auto mark", async () => {
    const { user, onEdit } = setup();
    await user.click(title());
    await user.keyboard("{End} live{Enter}");
    expect(onEdit).toHaveBeenCalledExactlyOnceWith({
      op: "set",
      key: "item.title",
      value: "Nobody asked the river live",
    });
    expect(
      screen.getByRole("button", { name: "Nobody asked the river live" }),
    ).toHaveFocus();
    expect(screen.queryByText("Auto")).toBeNull();
  });

  it("Escape cancels without an edit and returns focus", async () => {
    const { user, onEdit } = setup();
    await user.click(title());
    await user.keyboard("zzz{Escape}");
    expect(onEdit).not.toHaveBeenCalled();
    expect(title()).toHaveFocus();
  });

  it("Use auto resets a pinned title with one unset", async () => {
    const { user, onEdit } = setup();
    await user.click(title());
    await user.keyboard("{End} live{Enter}");
    await user.click(
      screen.getByRole("button", { name: "Nobody asked the river live" }),
    );
    await user.keyboard("more");
    await user.click(screen.getByRole("button", { name: "Use auto" }));
    expect(onEdit).toHaveBeenLastCalledWith({ op: "unset", key: "item.title" });
    expect(onEdit).toHaveBeenCalledTimes(2);
    expect(title()).toBeInTheDocument();
    expect(screen.getByText("Auto")).toBeInTheDocument();
  });

  it("emptying a value hands it back", async () => {
    const { user, onEdit } = setup();
    await user.click(title());
    await user.clear(
      screen.getByRole("textbox", { name: "Edit episode title" }),
    );
    await user.keyboard("{Enter}");
    expect(onEdit).toHaveBeenCalledWith({ op: "unset", key: "item.title" });
  });

  it("the strip fix opens the first missing value for editing", async () => {
    const { user, onEdit } = setup(PENDING);
    expect(screen.getByText("2 things left")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Add address" })[0]);
    await user.keyboard("https://cdn.example.test/a.mp3{Enter}");
    expect(onEdit).toHaveBeenCalledExactlyOnceWith({
      op: "set",
      key: "item.enclosure.url",
      value: "https://cdn.example.test/a.mp3",
    });
    expect(screen.getByText("1 thing left")).toBeInTheDocument();
  });

  it("hands host fixes and source jumps to the host", async () => {
    const { user, onFix, onOpenSource } = setup(PENDING);
    await user.click(
      screen.getAllByRole("button", { name: "Export episode" })[0],
    );
    expect(onFix).toHaveBeenCalledWith({ kind: "export" });
    await user.click(screen.getByRole("button", { name: "Edit chapters" }));
    expect(onOpenSource).toHaveBeenCalledWith("chapters");
    await user.click(
      screen.getByRole("button", { name: "2 soundbites. Open clips" }),
    );
    expect(onOpenSource).toHaveBeenCalledWith("clips");
  });

  it("Keep mine re-pins the same text and clears the drift", async () => {
    const { user, onEdit } = setup(DRIFTED);
    await user.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ op: "set", key: "item.notes" }),
    );
    expect(screen.queryByText(/changed since you edited/)).toBeNull();
  });

  it("Use new unsets the pin and shows the live notes", async () => {
    const { user, onEdit } = setup(DRIFTED);
    await user.click(screen.getByRole("button", { name: "Use new" }));
    expect(onEdit).toHaveBeenCalledWith({ op: "unset", key: "item.notes" });
    expect(screen.getByText("What the river wanted")).toBeInTheDocument();
  });

  it("creates the show from the name alone", async () => {
    const { user, onCreateShow } = setup(FIRST_RUN);
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    await user.type(
      screen.getByLabelText("Show name"),
      "The Long River{Enter}",
    );
    expect(onCreateShow).toHaveBeenCalledExactlyOnceWith("The Long River");
  });

  it("the show fix focuses the name field", async () => {
    const { user } = setup(FIRST_RUN);
    await user.click(screen.getByRole("button", { name: "Set up your show" }));
    expect(screen.getByLabelText("Show name")).toHaveFocus();
  });

  it("blocks Copy item and Write while a blocker stands", () => {
    setup(CHECKS);
    expect(screen.getByRole("button", { name: "Copy item" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Write feed file" }),
    ).toBeDisabled();
  });

  it("writes a stale file and reports it out of date until then", async () => {
    const { user, onWrite } = setup(STALE);
    expect(screen.getByText("Feed file is out of date.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Write" }));
    expect(onWrite).toHaveBeenCalledOnce();
  });

  it("shows the item XML in the XML view", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "XML" }));
    expect(screen.getByLabelText("Item XML")).toHaveTextContent(
      '<enclosure url="https://cdn.example.test/long-river/ep-12.mp3"',
    );
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("an agent pin says Agent until a person edits it", async () => {
    const { user } = setup(AGENT_PIN);
    expect(screen.getByText("Agent")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^A walk along/ }));
    await user.keyboard(" Listen.{Enter}");
    expect(screen.queryByText("Agent")).toBeNull();
  });
});
