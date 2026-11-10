import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Seam } from "./Seam";

const cut = {
  form: "diamond",
  kind: "cut",
  label: "Cut at 12:04.3",
  detail: "2.4 s removed",
  onSelect: () => undefined,
} as const;

describe("Seam as a diamond", () => {
  it("names the seam and selects it on click", async () => {
    const onSelect = vi.fn();
    render(<Seam {...cut} onSelect={onSelect} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Cut at 12:04.3, 2.4 s removed" }),
    );
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("hands a key press on its button to the host", async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    render(<Seam {...cut} onKeyDown={onKeyDown} />);
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(onKeyDown.mock.calls[0][0].key).toBe("ArrowRight");
  });

  it("takes the tab index its host gives it, and is a tab stop of its own without one", () => {
    const { rerender } = render(<Seam {...cut} onSelect={vi.fn()} />);
    expect(screen.getByRole("button").tabIndex).toBe(0);
    rerender(<Seam {...cut} onSelect={vi.fn()} tabIndex={-1} />);
    expect(screen.getByRole("button").tabIndex).toBe(-1);
  });

  it("tells a cut from a split and a selected seam from the rest", () => {
    const { container, rerender } = render(<Seam {...cut} />);
    const seam = () => container.querySelector(".sys-seam");
    expect(seam()).toHaveAttribute("data-kind", "cut");
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
    rerender(<Seam {...cut} kind="split" label="Split at 12:04.3" selected />);
    expect(seam()).toHaveAttribute("data-kind", "split");
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the label and detail while the pointer is over it", () => {
    render(<Seam {...cut} />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Cut at 12:04.32.4 s removed",
    );
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("never opens a tip for a touch", () => {
    render(<Seam {...cut} />);
    fireEvent.pointerEnter(screen.getByRole("button"), {
      pointerType: "touch",
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes the tip on Escape and opens it again after the pointer leaves", () => {
    render(<Seam {...cut} />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("opens the tip for keyboard focus", async () => {
    const user = userEvent.setup();
    render(<Seam {...cut} />);
    await user.tab();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Cut at 12:04.3");
    await user.tab();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("Seam as a text pill", () => {
  const pill = {
    form: "pill",
    removed: "2.4 s",
    words: "so, um, you know",
    onSelect: () => undefined,
  } as const;

  it("shows the removed length and puts it in the name", () => {
    render(<Seam {...pill} />);
    const button = screen.getByRole("button", { name: "Cut, 2.4 s removed" });
    expect(button).toHaveTextContent("2.4 s");
  });

  it("describes the cut words without a tip, as a touch or screen reader meets it", () => {
    render(<Seam {...pill} />);
    expect(screen.getByRole("button")).toHaveAccessibleDescription(
      "so, um, you know",
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("names a diamond with its detail, and by its label alone without one", () => {
    const { rerender } = render(<Seam {...cut} />);
    expect(screen.getByRole("button")).toHaveAccessibleName(
      "Cut at 12:04.3, 2.4 s removed",
    );
    rerender(<Seam {...cut} detail={undefined} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Cut at 12:04.3");
  });

  it("shows the cut words on hover", () => {
    render(<Seam {...pill} />);
    fireEvent.pointerEnter(screen.getByRole("button"), {
      pointerType: "mouse",
    });
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Cut 2.4 sso, um, you know",
    );
  });

  it("has no tip when it does not know the words", () => {
    render(<Seam {...pill} words={undefined} />);
    fireEvent.pointerEnter(screen.getByRole("button"), {
      pointerType: "mouse",
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("selects on click", async () => {
    const onSelect = vi.fn();
    render(<Seam {...pill} onSelect={onSelect} selected />);
    await userEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Seam pill rolling", () => {
  const pill = {
    form: "pill",
    removed: "2.4 s",
    onSelect: () => undefined,
  } as const;
  const edge = (container: HTMLElement, side: "left" | "right") =>
    container.querySelector<HTMLElement>(
      `.sys-seam-edge[data-side="${side}"]`,
    )!;

  it("has no edges without a roll", () => {
    const { container } = render(<Seam {...pill} />);
    expect(container.querySelector(".sys-seam-edge")).toBeNull();
  });

  it("rolls by the drag, shows the ms readout, and saves once on release", () => {
    const onCommit = vi.fn();
    const { container } = render(
      <Seam
        {...pill}
        roll={{ limits: () => ({ minMs: -500, maxMs: 500 }), onCommit }}
      />,
    );
    const right = edge(container, "right");
    fireEvent.pointerDown(right, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(right, { pointerId: 1, clientX: 108 });
    fireEvent.pointerMove(right, { pointerId: 1, clientX: 140 });
    expect(container.querySelector(".sys-seam-readout")).toHaveTextContent(
      "+500 ms",
    );
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(right, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toBe(500);
    expect(container.querySelector(".sys-seam-readout")).toBeNull();
  });

  it("commits the whole milliseconds its readout shows", () => {
    const onCommit = vi.fn();
    const { container } = render(
      <Seam
        {...pill}
        roll={{ limits: () => ({ minMs: -500, maxMs: 500 }), onCommit }}
      />,
    );
    const right = edge(container, "right");
    fireEvent.pointerDown(right, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(right, { pointerId: 1, clientX: 108 });
    fireEvent.pointerMove(right, { pointerId: 1, clientX: 109 });
    expect(container.querySelector(".sys-seam-readout")).toHaveTextContent(
      "+113 ms",
    );
    fireEvent.pointerUp(right, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith(113);
  });

  it("holds the roll to the room the clips leave", () => {
    const onCommit = vi.fn();
    const { container } = render(
      <Seam
        {...pill}
        roll={{ limits: () => ({ minMs: -100, maxMs: 100 }), onCommit }}
      />,
    );
    const left = edge(container, "left");
    fireEvent.pointerDown(left, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(left, { pointerId: 1, clientX: 20 });
    fireEvent.pointerUp(left, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith(-100);
  });

  it("Alt drags 1 ms a pixel and Shift is not a fine modifier", () => {
    const onCommit = vi.fn();
    const { container } = render(
      <Seam
        {...pill}
        roll={{ limits: () => ({ minMs: -500, maxMs: 500 }), onCommit }}
      />,
    );
    const right = edge(container, "right");
    const drag = (pointerId: number, modifiers: object) => {
      fireEvent.pointerDown(right, { pointerId, button: 0, clientX: 100 });
      fireEvent.pointerMove(right, { pointerId, clientX: 104, ...modifiers });
      fireEvent.pointerMove(right, { pointerId, clientX: 108, ...modifiers });
      fireEvent.pointerUp(right, { pointerId });
    };
    drag(1, { altKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(8);
    drag(2, { shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(100);
  });

  it("Escape drops the roll, and a press without a move selects the seam", () => {
    const onCommit = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <Seam
        {...pill}
        onSelect={onSelect}
        roll={{ limits: () => ({ minMs: -500, maxMs: 500 }), onCommit }}
      />,
    );
    const right = edge(container, "right");
    fireEvent.pointerDown(right, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(right, { pointerId: 1, clientX: 130 });
    expect(screen.getByRole("button")).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button"), { key: "Escape" });
    fireEvent.pointerUp(right, { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerDown(right, { pointerId: 2, button: 0, clientX: 100 });
    fireEvent.pointerUp(right, { pointerId: 2 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("takes no roll when the clips cannot roll", () => {
    const onCommit = vi.fn();
    const { container } = render(
      <Seam {...pill} roll={{ limits: () => null, onCommit }} />,
    );
    const right = edge(container, "right");
    fireEvent.pointerDown(right, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(right, { pointerId: 1, clientX: 140 });
    fireEvent.pointerUp(right, { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each([
    ["pill", { form: "pill", removed: "2.4 s", onSelect: () => undefined }],
    [
      "diamond",
      {
        form: "diamond",
        kind: "split",
        label: "Split at 0:05.0",
        onSelect: () => undefined,
      },
    ],
  ] as const)("Alt with an arrow key rolls a %s 1 ms", (_form, props) => {
    const onCommit = vi.fn();
    render(
      <Seam
        {...props}
        roll={{
          limits: () => ({ minMs: -500, maxMs: 500 }),
          pxPerSec: 100,
          onCommit,
        }}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button"), {
      key: "ArrowLeft",
      altKey: true,
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(-1);
  });

  it("a held Alt arrow rolls once, not once per key repeat", () => {
    const onCommit = vi.fn();
    render(
      <Seam
        {...pill}
        roll={{ limits: () => ({ minMs: -500, maxMs: 500 }), onCommit }}
      />,
    );
    const hit = screen.getByRole("button");
    fireEvent.keyDown(hit, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(hit, { key: "ArrowRight", altKey: true, repeat: true });
    fireEvent.keyDown(hit, { key: "ArrowRight", altKey: true, repeat: true });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe("Seam diamond rolling", () => {
  const diamond = {
    form: "diamond",
    kind: "split",
    label: "Split at 0:05.0",
    onSelect: () => undefined,
  } as const;
  const room = { limits: () => ({ minMs: -500, maxMs: 500 }) };
  const hit = () => screen.getByRole("button");

  it("rolls with the drag at the timeline's pixels per second and saves once on release", () => {
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    const { container } = render(
      <Seam
        {...diamond}
        roll={{ ...room, pxPerSec: 100, onCommit, onPreview }}
      />,
    );
    fireEvent.pointerDown(hit(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(hit(), { pointerId: 1, clientX: 120 });
    expect(onPreview).toHaveBeenLastCalledWith(200);
    expect(container.querySelector(".sys-seam-readout")).toHaveTextContent(
      "+200 ms",
    );
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(hit(), { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(200);
    expect(container.querySelector(".sys-seam-readout")).toBeNull();
  });

  it("keeps the preview until the save settles", async () => {
    let settle!: () => void;
    const onCommit = vi.fn(() => new Promise<void>((r) => (settle = r)));
    const onPreview = vi.fn();
    render(
      <Seam
        {...diamond}
        roll={{ ...room, pxPerSec: 100, onCommit, onPreview }}
      />,
    );
    fireEvent.pointerDown(hit(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(hit(), { pointerId: 1, clientX: 120 });
    fireEvent.pointerUp(hit(), { pointerId: 1 });
    expect(onPreview).not.toHaveBeenCalledWith(null);
    settle();
    await vi.waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(null));
  });

  it("Alt rolls at a twelfth and a half of the pace, to a tenth of a millisecond", () => {
    const onCommit = vi.fn();
    render(<Seam {...diamond} roll={{ ...room, pxPerSec: 1000, onCommit }} />);
    fireEvent.pointerDown(hit(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(hit(), { pointerId: 1, clientX: 110, altKey: true });
    fireEvent.pointerUp(hit(), { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.8);
  });

  it("holds the roll to the room the clips leave", () => {
    const onCommit = vi.fn();
    render(
      <Seam
        {...diamond}
        roll={{
          limits: () => ({ minMs: -50, maxMs: 50 }),
          pxPerSec: 100,
          onCommit,
        }}
      />,
    );
    fireEvent.pointerDown(hit(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(hit(), { pointerId: 1, clientX: 400 });
    fireEvent.pointerUp(hit(), { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith(50);
  });

  it("Escape drops the roll and its preview", () => {
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    render(
      <Seam
        {...diamond}
        roll={{ ...room, pxPerSec: 100, onCommit, onPreview }}
      />,
    );
    fireEvent.pointerDown(hit(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(hit(), { pointerId: 1, clientX: 130 });
    fireEvent.keyDown(hit(), { key: "Escape" });
    fireEvent.pointerUp(hit(), { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenLastCalledWith(null);
  });

  it("a press without a move selects, and a drag does not also select", async () => {
    const onSelect = vi.fn();
    render(
      <Seam
        {...diamond}
        onSelect={onSelect}
        roll={{ ...room, pxPerSec: 100, onCommit: vi.fn() }}
      />,
    );
    fireEvent.pointerDown(hit(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerUp(hit(), { pointerId: 1 });
    fireEvent.click(hit());
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(hit(), { pointerId: 2, button: 0, clientX: 100 });
    fireEvent.pointerMove(hit(), { pointerId: 2, clientX: 140 });
    fireEvent.pointerUp(hit(), { pointerId: 2 });
    fireEvent.click(hit());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("takes no roll when the clips cannot roll, and still selects", () => {
    const onCommit = vi.fn();
    const onSelect = vi.fn();
    render(
      <Seam
        {...diamond}
        onSelect={onSelect}
        roll={{ limits: () => null, pxPerSec: 100, onCommit }}
      />,
    );
    fireEvent.pointerDown(hit(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(hit(), { pointerId: 1, clientX: 140 });
    fireEvent.pointerUp(hit(), { pointerId: 1 });
    fireEvent.click(hit());
    expect(onCommit).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("takes no roll from a press the host refuses, as an unarmed touch", () => {
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    render(
      <Seam
        {...diamond}
        roll={{
          ...room,
          pxPerSec: 100,
          onCommit,
          onPreview,
          acceptsPointer: () => false,
        }}
      />,
    );
    fireEvent.pointerDown(hit(), {
      pointerId: 1,
      button: 0,
      pointerType: "touch",
      clientX: 100,
    });
    fireEvent.pointerMove(hit(), { pointerId: 1, clientX: 160 });
    fireEvent.pointerUp(hit(), { pointerId: 1 });
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rolls from a press the host accepts", () => {
    const onCommit = vi.fn();
    render(
      <Seam
        {...diamond}
        roll={{
          ...room,
          pxPerSec: 100,
          onCommit,
          acceptsPointer: () => true,
        }}
      />,
    );
    fireEvent.pointerDown(hit(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(hit(), { pointerId: 1, clientX: 130 });
    fireEvent.pointerUp(hit(), { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(300);
  });

  it("clears the preview when it unmounts mid-drag", () => {
    const onPreview = vi.fn();
    const { unmount } = render(
      <Seam
        {...diamond}
        roll={{ ...room, pxPerSec: 100, onCommit: vi.fn(), onPreview }}
      />,
    );
    fireEvent.pointerDown(hit(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(hit(), { pointerId: 1, clientX: 130 });
    onPreview.mockClear();
    unmount();
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("does not select on the click that follows a cancelled drag", () => {
    const onSelect = vi.fn();
    render(
      <Seam
        {...diamond}
        onSelect={onSelect}
        roll={{ ...room, pxPerSec: 100, onCommit: vi.fn() }}
      />,
    );
    fireEvent.pointerDown(hit(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(hit(), { pointerId: 1, clientX: 130 });
    fireEvent.keyDown(hit(), { key: "Escape" });
    fireEvent.pointerUp(hit(), { pointerId: 1 });
    fireEvent.click(hit());
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(hit());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("marks its button with the host's data attributes", () => {
    render(<Seam {...diamond} hit={{ "data-hit-kind": "roll" }} />);
    expect(hit()).toHaveAttribute("data-hit-kind", "roll");
  });
});
