import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
    useDawStore.setState({ transcriptInlineEditFailure: null });
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

  it("ignores Escape while a commit is in flight", async () => {
    let resolve: () => void = () => {};
    vi.mocked(correctTranscriptWord).mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
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
    await waitFor(() => expect(correctTranscriptWord).toHaveBeenCalled());
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("readonly");
    await act(async () => {
      resolve();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("shows a failure that settles after Escape was pressed", async () => {
    let reject: (e: Error) => void = () => {};
    vi.mocked(correctTranscriptWord).mockImplementationOnce(
      () =>
        new Promise<void>((_r, rej) => {
          reject = rej;
        }),
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
    await waitFor(() => expect(correctTranscriptWord).toHaveBeenCalled());
    await user.keyboard("{Escape}");
    await act(async () => {
      reject(new Error("network down"));
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("network down");
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves focus outside when the user moved away during a commit", async () => {
    const outside = document.createElement("input");
    outside.setAttribute("aria-label", "outside");
    document.body.append(outside);
    try {
      let resolve: () => void = () => {};
      vi.mocked(correctTranscriptWord).mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolve = r;
          }),
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
      await waitFor(() => expect(correctTranscriptWord).toHaveBeenCalled());
      act(() => outside.focus());
      await act(async () => {
        resolve();
      });
      await waitFor(() => expect(onClose).toHaveBeenCalledWith(false));
      expect(outside).toHaveFocus();
    } finally {
      outside.remove();
    }
  });

  it("does not pull focus back when a commit fails after the user moved away", async () => {
    const outside = document.createElement("input");
    outside.setAttribute("aria-label", "outside");
    document.body.append(outside);
    try {
      let reject: (e: Error) => void = () => {};
      vi.mocked(correctTranscriptWord).mockImplementationOnce(
        () =>
          new Promise<void>((_r, rej) => {
            reject = rej;
          }),
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
      await waitFor(() => expect(correctTranscriptWord).toHaveBeenCalled());
      act(() => outside.focus());
      await act(async () => {
        reject(new Error("network down"));
      });
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("network down");
      });
      expect(outside).toHaveFocus();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
  });

  it("reports busy while a commit is in flight", async () => {
    const onBusyChange = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineWordEditor
        trackId="host"
        wordIndex={0}
        initialText="hello"
        onClose={vi.fn()}
        onBusyChange={onBusyChange}
      />,
    );
    const input = screen.getByRole("textbox", { name: /Correct word/ });
    await user.clear(input);
    await user.type(input, "Hello{Enter}");
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
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
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute("readonly");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports a failure that settles after unmount to the transcript failure banner", async () => {
    let reject: (e: Error) => void = () => {};
    vi.mocked(correctTranscriptWord).mockImplementationOnce(
      () =>
        new Promise<void>((_r, rej) => {
          reject = rej;
        }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
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
    await waitFor(() => expect(correctTranscriptWord).toHaveBeenCalled());
    unmount();
    await act(async () => {
      reject(new Error("network down"));
    });
    await waitFor(() =>
      expect(useDawStore.getState().transcriptInlineEditFailure).toEqual({
        projectPath: "/tmp/ep",
        trackId: "host",
        wordIndex: 0,
        originalText: "hello",
        message: "Could not fix “hello”: network down",
      }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("neither closes nor reports after unmount when the commit succeeds", async () => {
    let resolve: () => void = () => {};
    vi.mocked(correctTranscriptWord).mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const onClose = vi.fn();
    const onBusyChange = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <InlineWordEditor
        trackId="host"
        wordIndex={0}
        initialText="hello"
        onClose={onClose}
        onBusyChange={onBusyChange}
      />,
    );
    const input = screen.getByRole("textbox", { name: /Correct word/ });
    await user.clear(input);
    await user.type(input, "Hello{Enter}");
    await waitFor(() => expect(correctTranscriptWord).toHaveBeenCalled());
    unmount();
    await act(async () => {
      resolve();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(useDawStore.getState().transcriptInlineEditFailure).toBeNull();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
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
