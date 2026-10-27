import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { stubMatchMedia } from "../test/matchMedia";
import { Composer, type ComposerProps } from "./Composer";
import { composerBlock } from "./composerBlock";

function Harness(props: Partial<ComposerProps> & { start?: string }) {
  const { start = "", ...rest } = props;
  const [body, setBody] = useState(start);
  return (
    <Composer
      body={body}
      onBodyChange={setBody}
      onSubmit={() => undefined}
      {...rest}
    />
  );
}

const field = () => screen.getByRole("textbox", { name: "Comment" });
const submit = (name = "Post") => screen.getByRole("button", { name });
const noop = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Composer", () => {
  it("keeps Post off until the body has text, and says why", async () => {
    render(<Harness />);
    expect(submit()).toBeDisabled();
    expect(submit()).toHaveAttribute("title", "Write a comment to post.");
    await userEvent.type(field(), "  ");
    expect(submit()).toBeDisabled();
    await userEvent.type(field(), "Cut this");
    expect(submit()).toBeEnabled();
  });

  describe("keys on a fine pointer", () => {
    it("posts on Enter and adds no line", async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<Harness start="Hi" onSubmit={onSubmit} />);
      await user.click(field());
      await user.keyboard("{Enter}");
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(field()).toHaveValue("Hi");
    });

    it("adds a line on Shift+Enter and does not post", async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<Harness start="Hi" onSubmit={onSubmit} />);
      await user.click(field());
      await user.keyboard("{Shift>}{Enter}{/Shift}");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(field()).toHaveValue("Hi\n");
    });

    it("posts on Ctrl+Enter and on Cmd+Enter", async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<Harness start="Hi" onSubmit={onSubmit} />);
      await user.click(field());
      await user.keyboard("{Control>}{Enter}{/Control}");
      await user.keyboard("{Meta>}{Enter}{/Meta}");
      expect(onSubmit).toHaveBeenCalledTimes(2);
    });

    it("does nothing on Enter while the body is empty, and inserts no line", async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<Harness onSubmit={onSubmit} />);
      await user.click(field());
      await user.keyboard("{Enter}");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(field()).toHaveValue("");
    });

    it("does not post when Enter confirms an IME composition", () => {
      const onSubmit = vi.fn();
      render(<Harness start="にほん" onSubmit={onSubmit} />);
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      field().dispatchEvent(event);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it("does not post when Safari confirms an IME composition after compositionend", () => {
      const onSubmit = vi.fn();
      render(<Harness start="にほん" onSubmit={onSubmit} />);
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      });
      field().dispatchEvent(event);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it("advertises Enter and the send hint", () => {
      render(<Harness />);
      expect(field()).toHaveAttribute("aria-keyshortcuts", "Enter");
      expect(field()).toHaveAttribute("enterkeyhint", "send");
    });
  });

  describe("keys on a coarse pointer", () => {
    it("makes Return a new line and posts from the arrow", async () => {
      stubMatchMedia(true);
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<Harness start="Hi" onSubmit={onSubmit} />);
      await user.click(field());
      await user.keyboard("{Enter}");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(field()).toHaveValue("Hi\n");
      await user.click(submit());
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it("still posts on Ctrl+Enter from a hardware keyboard", async () => {
      stubMatchMedia(true);
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<Harness start="Hi" onSubmit={onSubmit} />);
      await user.click(field());
      await user.keyboard("{Control>}{Enter}{/Control}");
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it("hints Return as a new line and omits the Enter shortcut", () => {
      stubMatchMedia(true);
      render(<Harness />);
      expect(field()).toHaveAttribute("enterkeyhint", "enter");
      expect(field()).not.toHaveAttribute("aria-keyshortcuts");
    });
  });

  describe("anchor chip", () => {
    it("moves focus to the chip when the clear control turns the anchor into the whole episode", async () => {
      function Anchored() {
        const [kind, setKind] = useState<"pinned" | "episode">("pinned");
        return (
          <Composer
            body=""
            onBodyChange={noop}
            onSubmit={noop}
            anchor={kind === "pinned" ? { kind, start: 18 } : { kind }}
            onAnchor={(intent) => intent === "episode" && setKind("episode")}
          />
        );
      }
      render(<Anchored />);
      await userEvent.click(
        screen.getByRole("button", { name: "Make it a whole-episode note" }),
      );
      expect(
        screen.queryByRole("button", { name: "Make it a whole-episode note" }),
      ).toBeNull();
      expect(
        screen.getByRole("button", {
          name: "Whole-episode note. Pin to the playhead",
        }),
      ).toHaveFocus();
    });

    it("hands focus to the field when posting replaces a focused chip with text", () => {
      const anchor = { kind: "pinned", start: 18 } as const;
      const { rerender } = render(
        <Composer
          body="hi"
          onBodyChange={noop}
          onSubmit={noop}
          anchor={anchor}
          onAnchor={noop}
        />,
      );
      screen
        .getByRole("button", { name: /^Pinned .*Move to the playhead$/ })
        .focus();
      rerender(
        <Composer
          body="hi"
          onBodyChange={noop}
          onSubmit={noop}
          anchor={anchor}
          onAnchor={noop}
          state="posting"
        />,
      );
      expect(field()).toHaveFocus();
    });

    it("shows a following chip as timecode and asks to pin on every keystroke", async () => {
      const onAnchor = vi.fn();
      render(
        <Harness
          anchor={{ kind: "follow", seconds: 1116.4 }}
          onAnchor={onAnchor}
        />,
      );
      expect(
        screen.getByRole("button", {
          name: "Comment at 18:36, follows the playhead. Pin it here",
        }),
      ).toBeVisible();
      await userEvent.type(field(), "ab");
      expect(onAnchor.mock.calls).toEqual([["pin"], ["pin"]]);
    });

    it("does not ask to pin an anchor that is already pinned or whole-episode", async () => {
      const onAnchor = vi.fn();
      const { rerender } = render(
        <Composer
          body=""
          onBodyChange={noop}
          onSubmit={noop}
          anchor={{ kind: "pinned", start: 18 }}
          onAnchor={onAnchor}
        />,
      );
      await userEvent.type(field(), "a");
      rerender(
        <Composer
          body=""
          onBodyChange={noop}
          onSubmit={noop}
          anchor={{ kind: "episode" }}
          onAnchor={onAnchor}
        />,
      );
      await userEvent.type(field(), "a");
      expect(onAnchor).not.toHaveBeenCalled();
    });

    it("re-anchors from a pinned chip, naming a range", async () => {
      const onAnchor = vi.fn();
      render(
        <Harness
          anchor={{ kind: "pinned", start: 1116, end: 1121 }}
          onAnchor={onAnchor}
        />,
      );
      await userEvent.click(
        screen.getByRole("button", {
          name: "Pinned 18:36 to 18:41. Move to the playhead",
        }),
      );
      expect(onAnchor).toHaveBeenLastCalledWith("here");
    });

    it("clears to a whole-episode note, and the episode chip pins again", async () => {
      const onAnchor = vi.fn();
      const { rerender } = render(
        <Composer
          body=""
          onBodyChange={noop}
          onSubmit={noop}
          anchor={{ kind: "pinned", start: 1116 }}
          onAnchor={onAnchor}
        />,
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Make it a whole-episode note" }),
      );
      expect(onAnchor).toHaveBeenLastCalledWith("episode");
      rerender(
        <Composer
          body=""
          onBodyChange={noop}
          onSubmit={noop}
          anchor={{ kind: "episode" }}
          onAnchor={onAnchor}
        />,
      );
      expect(screen.getByText("Whole episode")).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Make it a whole-episode note" }),
      ).toBeNull();
      await userEvent.click(
        screen.getByRole("button", {
          name: "Whole-episode note. Pin to the playhead",
        }),
      );
      expect(onAnchor).toHaveBeenLastCalledWith("here");
    });

    it("is static text with no clear control when there is no onAnchor", () => {
      render(<Harness anchor={{ kind: "pinned", start: 1116 }} />);
      expect(screen.getByText("18:36")).toBeVisible();
      expect(screen.getByText("Pinned")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Pinned|whole/i }),
      ).toBeNull();
    });

    it("is static text while posting", () => {
      render(
        <Harness
          start="x"
          state="posting"
          anchor={{ kind: "pinned", start: 1116 }}
          onAnchor={noop}
        />,
      );
      expect(
        screen.queryByRole("button", { name: /Move to the playhead/ }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Make it a whole-episode note" }),
      ).toBeNull();
      expect(screen.getByText("18:36")).toBeVisible();
    });

    it("has no chip when there is no anchor", () => {
      render(<Harness />);
      expect(screen.queryByText(/^\d+:\d\d$/)).toBeNull();
      expect(screen.queryByText("Whole episode")).toBeNull();
    });
  });

  it("keeps focus in the field after the arrow posts and the caller clears the body", async () => {
    function Clearing() {
      const [body, setBody] = useState("hello");
      return (
        <Composer
          body={body}
          onBodyChange={setBody}
          onSubmit={() => setBody("")}
        />
      );
    }
    render(<Clearing />);
    await userEvent.click(submit());
    expect(field()).toHaveValue("");
    expect(field()).toHaveFocus();
  });

  describe("guest name", () => {
    it("posts with a blank name", async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(
        <Harness
          start="Nice"
          onSubmit={onSubmit}
          name={{ value: "", onChange: noop }}
        />,
      );
      expect(submit()).toBeEnabled();
      await user.click(submit());
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it("takes a name, with the spec placeholder", async () => {
      const onChange = vi.fn();
      render(<Harness start="Nice" name={{ value: "", onChange }} />);
      const input = screen.getByRole("textbox", { name: "Your name" });
      expect(input).toHaveAttribute(
        "placeholder",
        "Name, so the host knows who said it",
      );
      expect(input).toHaveAttribute("autocomplete", "name");
      await userEvent.type(input, "R");
      expect(onChange).toHaveBeenCalledWith("R");
    });

    it("moves to the comment on Enter without posting, and posts on Ctrl+Enter", async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(
        <Harness
          start="Nice"
          onSubmit={onSubmit}
          name={{ value: "Rosa", onChange: noop }}
        />,
      );
      await user.click(screen.getByRole("textbox", { name: "Your name" }));
      await user.keyboard("{Enter}");
      expect(field()).toHaveFocus();
      expect(onSubmit).not.toHaveBeenCalled();
      await user.click(screen.getByRole("textbox", { name: "Your name" }));
      await user.keyboard("{Control>}{Enter}{/Control}");
      expect(onSubmit).toHaveBeenCalledOnce();
    });
  });

  it("keeps focus in the name field when Safari confirms an IME composition", () => {
    render(<Harness start="Nice" name={{ value: "ろーざ", onChange: noop }} />);
    const input = screen.getByRole("textbox", { name: "Your name" });
    input.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    expect(input).toHaveFocus();
    expect(event.defaultPrevented).toBe(false);
  });

  it("queues offline: a named arrow and a glyph, still postable", () => {
    render(<Harness start="Later" state="offline" />);
    const button = submit("Queue comment");
    expect(button).toBeEnabled();
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("locks the field while posting", () => {
    render(<Harness start="Sent" state="posting" />);
    expect(submit("Posting…")).toBeDisabled();
    expect(submit("Posting…")).toHaveAttribute("aria-busy", "true");
    expect(field()).toHaveAttribute("readonly");
  });

  it("puts the arrow inside the field and never fills it with the accent", () => {
    render(<Harness start="x" />);
    expect(submit().closest(".sys-composer-field")).not.toBeNull();
    expect(submit()).not.toHaveClass("primary");
  });

  it("takes a custom field name, labels and placeholder", () => {
    render(
      <Harness
        label="Reply to Rosa"
        submitLabel="Reply"
        placeholder="Reply…"
        start="a"
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Reply to Rosa" }),
    ).toHaveAttribute("placeholder", "Reply…");
    expect(submit("Reply")).toBeEnabled();
  });

  it("hands the field to inputRef so the caller can focus it", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Harness inputRef={ref} />);
    expect(ref.current).toBe(field());
    ref.current?.focus();
    expect(field()).toHaveFocus();
  });

  it("explains each block in one order", () => {
    expect(composerBlock({ body: "x", state: "posting" })).toBe(
      "Wait for the current action to finish.",
    );
    expect(composerBlock({ body: " ", state: "posting" })).toBe(
      "Wait for the current action to finish.",
    );
    expect(composerBlock({ body: " " })).toBe("Write a comment to post.");
    expect(composerBlock({ body: "x" })).toBeUndefined();
    expect(composerBlock({ body: "x", state: "offline" })).toBeUndefined();
  });

  it("renders no live region: the shell announces", () => {
    const { container } = render(
      <>
        <Harness
          start="x"
          state="offline"
          anchor={{ kind: "follow", seconds: 3 }}
          onAnchor={noop}
        />
        <Harness start="x" state="posting" />
      </>,
    );
    expect(
      container.querySelector('[aria-live], [role="status"], [role="alert"]'),
    ).toBeNull();
  });

  it("has no axe violations in any state", async () => {
    const { container } = render(
      <>
        <Harness anchor={{ kind: "pinned", start: 3 }} onAnchor={noop} />
        <Harness anchor={{ kind: "episode" }} onAnchor={noop} />
        <Harness compact state="offline" name={{ value: "", onChange: noop }} />
        <Harness start="x" state="posting" />
      </>,
    );
    await expectNoA11yViolations(container);
  });
});
