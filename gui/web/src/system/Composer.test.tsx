import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
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

  it("posts on Ctrl+Enter and on Cmd+Enter, and not on a bare Enter", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness start="Hi" onSubmit={onSubmit} />);
    await user.click(field());
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("does not post on Ctrl+Enter while the body is empty", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSubmit={onSubmit} />);
    await user.click(field());
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the time chip in seconds and pins on the first keystroke", async () => {
    const onPinTime = vi.fn();
    render(
      <Harness
        time={{ seconds: 18.64, pinned: false }}
        onPinTime={onPinTime}
      />,
    );
    expect(screen.getByText("18.6 s")).toBeVisible();
    expect(screen.getByText("Follows the playhead")).toBeInTheDocument();
    await userEvent.type(field(), "ab");
    expect(onPinTime).toHaveBeenCalledTimes(2);
  });

  it("does not ask to pin a time that is already pinned", async () => {
    const onPinTime = vi.fn();
    render(
      <Harness time={{ seconds: 18, pinned: true }} onPinTime={onPinTime} />,
    );
    await userEvent.type(field(), "a");
    expect(onPinTime).not.toHaveBeenCalled();
  });

  it("unpins when the pinned chip is clicked", async () => {
    const onUnpinTime = vi.fn();
    render(
      <Harness
        time={{ seconds: 18, pinned: true }}
        onUnpinTime={onUnpinTime}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Pinned at 18.0 s. Follow the playhead",
      }),
    );
    expect(onUnpinTime).toHaveBeenCalledOnce();
  });

  it("has no chip for an unanchored comment", () => {
    render(<Harness />);
    expect(screen.queryByText(/ s$/)).toBeNull();
  });

  it("asks a guest for a name before posting", async () => {
    const onChange = vi.fn();
    render(
      <Harness start="Nice" name={{ value: "", onChange, required: true }} />,
    );
    expect(submit()).toBeDisabled();
    expect(submit()).toHaveAttribute("title", "Add your name to post.");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Your name" }),
      "R",
    );
    expect(onChange).toHaveBeenCalledWith("R");
  });

  it("posts a named guest comment once the name is there", () => {
    render(
      <Harness
        start="Nice"
        name={{ value: "Rosa", onChange: () => undefined, required: true }}
      />,
    );
    expect(submit()).toBeEnabled();
  });

  it("queues offline: label and a glyph, still postable", () => {
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

  it("is read-only with the reason in view", () => {
    render(
      <Harness
        start="x"
        disabledReason="Viewers can read comments, not write them."
      />,
    );
    expect(field()).toHaveAttribute("readonly");
    expect(submit()).toBeDisabled();
    expect(field()).toHaveAccessibleDescription(
      "Viewers can read comments, not write them.",
    );
  });

  it("takes a custom label and placeholder, and focuses on request", () => {
    const focus = { autoFocus: true };
    render(
      <Harness submitLabel="Reply" placeholder="Reply…" start="a" {...focus} />,
    );
    expect(submit("Reply")).toBeEnabled();
    expect(field()).toHaveAttribute("placeholder", "Reply…");
    expect(field()).toHaveFocus();
  });

  it("explains each block in one order", () => {
    const base = { body: "x" } as const;
    expect(composerBlock({ ...base, disabledReason: "Viewer" })).toBe("Viewer");
    expect(composerBlock({ ...base, state: "posting" })).toBe(
      "Wait for the current action to finish.",
    );
    expect(
      composerBlock({
        body: "",
        name: { value: "", onChange: () => undefined, required: true },
      }),
    ).toBe("Add your name to post.");
    expect(composerBlock({ body: " " })).toBe("Write a comment to post.");
    expect(composerBlock(base)).toBeUndefined();
  });

  it("has no axe violations in any state", async () => {
    const { container } = render(
      <>
        <Harness
          time={{ seconds: 3, pinned: true }}
          onUnpinTime={() => undefined}
        />
        <Harness
          compact
          state="offline"
          name={{ value: "", onChange: () => undefined, required: true }}
        />
        <Harness disabledReason="Viewers cannot comment." />
      </>,
    );
    await expectNoA11yViolations(container);
  });
});
