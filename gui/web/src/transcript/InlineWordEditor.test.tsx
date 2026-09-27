import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { InlineWordEditor } from "./InlineWordEditor";

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  correctTranscriptWord: vi.fn(async () => {}),
  correctTranscriptPhrase: vi.fn(async () => {}),
  refreshProject: vi.fn(),
}));

import { correctTranscriptWord } from "../api";

describe("InlineWordEditor", () => {
  beforeEach(() => {
    vi.mocked(correctTranscriptWord).mockClear();
    useDawStore.getState().hydrate("/tmp/ep", minimalProject());
  });

  it("mounts focused with the text selected", () => {
    render(
      <InlineWordEditor
        trackId="host"
        wordIndex={0}
        initialText="hello"
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: /Correct word/ });
    expect(input).toHaveFocus();
  });

  it("commits changed text on Enter", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineWordEditor
        trackId="host"
        wordIndex={0}
        initialText="hello"
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("textbox", { name: /Correct word/ });
    await user.clear(input);
    await user.type(input, "Hello{Enter}");
    await waitFor(() => {
      expect(correctTranscriptWord).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        0,
        "Hello",
      );
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
  });

  it("closes without a call when the text is unchanged", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineWordEditor
        trackId="host"
        wordIndex={0}
        initialText="hello"
        onClose={onClose}
      />,
    );
    await user.type(
      screen.getByRole("textbox", { name: /Correct word/ }),
      "{Enter}",
    );
    expect(correctTranscriptWord).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("shows an inline error for empty text and does not close", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineWordEditor
        trackId="host"
        wordIndex={0}
        initialText="hello"
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("textbox", { name: /Correct word/ });
    await user.clear(input);
    await user.type(input, "   {Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("Text cannot be empty");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(correctTranscriptWord).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape cancels without a call", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineWordEditor
        trackId="host"
        wordIndex={0}
        initialText="hello"
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("textbox", { name: /Correct word/ });
    await user.type(input, "changed");
    await user.keyboard("{Escape}");
    expect(correctTranscriptWord).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("blur cancels without restoring focus", () => {
    const onClose = vi.fn();
    render(
      <InlineWordEditor
        trackId="host"
        wordIndex={0}
        initialText="hello"
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("textbox", { name: /Correct word/ });
    fireEvent.blur(input);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it("keeps the editor open and shows the error when the API rejects", async () => {
    vi.mocked(correctTranscriptWord).mockRejectedValueOnce(
      new Error("network down"),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineWordEditor
        trackId="host"
        wordIndex={0}
        initialText="hello"
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("textbox", { name: /Correct word/ });
    await user.clear(input);
    await user.type(input, "Hello{Enter}");
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("network down");
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <InlineWordEditor
        trackId="host"
        wordIndex={0}
        initialText="hello"
        onClose={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
