import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { TrackFaderView, type TrackFaderViewProps } from "./TrackFaderView";

const props: TrackFaderViewProps = {
  trackLabel: "Mira voice",
  savedDb: -3,
  access: { kind: "read-only" },
  presentation: {
    kind: "detailed",
    stagingDb: -2,
    balance: { state: "current", measuredLufs: -24.5, ungated: true },
  },
};
function ControlledFader({ onCommit }: { onCommit: (db: number) => void }) {
  const [savedDb, setSavedDb] = useState(-3);
  return (
    <TrackFaderView
      {...props}
      savedDb={savedDb}
      access={{
        kind: "edit",
        onCommit: (db) => {
          onCommit(db);
          setSavedDb(db);
        },
      }}
    />
  );
}
function slider() {
  return screen.getByRole("slider", { name: "Volume Mira voice" });
}

describe("TrackFaderView", () => {
  it("keeps draft output and staging notes local until native change commits", () => {
    const onCommit = vi.fn();
    render(<ControlledFader onCommit={onCommit} />);
    fireEvent.input(slider(), { target: { value: "-6" } });
    expect(slider()).toHaveValue("-6");
    expect(slider()).toHaveAttribute("aria-valuetext", "−6.0 dB");
    expect(screen.getByRole("status")).toHaveTextContent("−6.0 dB");
    expect(
      screen.getByText("Staging gain −2.0 dB; plays at −8.0 dB"),
    ).toBeVisible();
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(slider(), { target: { value: "-6" } });
    expect(onCommit.mock.calls).toEqual([[-6]]);
    fireEvent.change(slider(), { target: { value: "-6" } });
    expect(onCommit.mock.calls).toEqual([[-6]]);
  });
  it("compact presentation shares native drafts, commits and double-click reset", () => {
    const onCommit = vi.fn();
    render(
      <>
        <p id="permission">Saved volume</p>
        <TrackFaderView
          {...props}
          presentation={{ kind: "compact", descriptionId: "permission" }}
          access={{ kind: "edit", onCommit }}
        />
      </>,
    );
    fireEvent.input(slider(), { target: { value: "-6" } });
    expect(slider()).toHaveValue("-6");
    expect(screen.getByRole("status")).toHaveTextContent("−6.0 dB");
    expect(slider()).toHaveAccessibleDescription("Saved volume");
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(slider(), { target: { value: "-6" } });
    expect(onCommit.mock.calls).toEqual([[-6]]);
    fireEvent.doubleClick(slider());
    expect(onCommit.mock.calls).toEqual([[-6], [0]]);
    expect(slider()).toHaveValue("0");
    expect(screen.queryByRole("button", { name: /Reset/ })).toBeNull();
  });

  it("Reset commits zero and returns focus when its button disables", async () => {
    const onCommit = vi.fn();
    render(<ControlledFader onCommit={onCommit} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Reset volume to 0 dB" }),
    );
    expect(onCommit.mock.calls).toEqual([[0]]);
    expect(slider()).toHaveValue("0");
    expect(slider()).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Reset volume to 0 dB" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Staging gain −2.0 dB; plays at −2.0 dB"),
    ).toBeVisible();
  });
  it("double-click resets and native changes commit keyboard-sized steps", () => {
    const onCommit = vi.fn();
    render(<ControlledFader onCommit={onCommit} />);
    fireEvent.change(slider(), { target: { value: "-2.5" } });
    expect(slider()).toHaveValue("-2.5");
    expect(onCommit.mock.calls).toEqual([[-2.5]]);
    fireEvent.doubleClick(slider());
    expect(slider()).toHaveValue("0");
    expect(onCommit.mock.calls).toEqual([[-2.5], [0]]);
  });
  it.each(["pointerUp", "pointerCancel", "blur"] as const)(
    "resumes saved updates after %s ends a draft",
    (event) => {
      const onCommit = vi.fn();
      const access = { kind: "edit" as const, onCommit };
      const view = render(<TrackFaderView {...props} access={access} />);
      fireEvent.input(slider(), { target: { value: "-6" } });
      view.rerender(
        <TrackFaderView {...props} savedDb={1.5} access={access} />,
      );
      expect(slider()).toHaveValue("-6");
      fireEvent[event](slider());
      view.rerender(<TrackFaderView {...props} savedDb={2} access={access} />);
      expect(slider()).toHaveValue("2");
      expect(
        screen.getByText("Staging gain −2.0 dB; plays at 0.0 dB"),
      ).toBeVisible();
      expect(onCommit).not.toHaveBeenCalled();
      fireEvent.change(slider(), { target: { value: "2.5" } });
      expect(onCommit.mock.calls).toEqual([[2.5]]);
    },
  );
  it("follows saved undo and collaborator updates without a draft", () => {
    const view = render(<TrackFaderView {...props} />);
    view.rerender(<TrackFaderView {...props} savedDb={1.5} />);
    expect(slider()).toHaveValue("1.5");
    expect(screen.getByRole("status")).toHaveTextContent("+1.5 dB");
    expect(
      screen.getByText("Balance current · -24.5 LUFS · ungated"),
    ).toBeVisible();
    view.rerender(<TrackFaderView {...props} savedDb={-3} />);
    expect(slider()).toHaveValue("-3");
  });
  it("revoked access disables the range and stops a pending native commit", async () => {
    const onCommit = vi.fn();
    const view = render(
      <TrackFaderView {...props} access={{ kind: "edit", onCommit }} />,
    );
    fireEvent.change(slider(), { target: { value: "-2.5" } });
    expect(onCommit.mock.calls).toEqual([[-2.5]]);
    fireEvent.input(slider(), { target: { value: "-6" } });
    view.rerender(<TrackFaderView {...props} />);
    expect(slider()).toBeDisabled();
    expect(slider()).toHaveAccessibleDescription(
      "Only the host and editors can change the volume. Staging gain −2.0 dB; plays at −8.0 dB",
    );
    expect(screen.queryByRole("button", { name: /Reset/ })).toBeNull();
    fireEvent.change(slider(), { target: { value: "-6" } });
    fireEvent.doubleClick(slider());
    expect(onCommit.mock.calls).toEqual([[-2.5]]);
    await expectNoA11yViolations(view.container);
  });
  it("associates each label, output and description with its own same-track input", async () => {
    const view = render(
      <>
        <TrackFaderView {...props} />
        <TrackFaderView {...props} />
      </>,
    );
    const sliders = screen.getAllByRole("slider", {
      name: "Volume Mira voice",
    });
    expect(new Set(sliders.map((input) => input.id)).size).toBe(2);
    sliders.forEach((input) => {
      expect(
        view.container.querySelector(`label[for="${input.id}"]`),
      ).toHaveTextContent("Volume");
      expect(
        view.container.querySelector(`output[for="${input.id}"]`),
      ).toHaveTextContent("−3.0 dB");
      expect(
        document.getElementById(input.getAttribute("aria-describedby") ?? ""),
      ).toHaveTextContent("plays at −5.0 dB");
    });
    await expectNoA11yViolations(view.container);
  });
});
