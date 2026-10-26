import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdvancedSteps, type AdvancedStepsProps } from "./AdvancedSteps";
import { GROUPS, RUNNING } from "./advancedFixture";
import { useAdvancedDemo } from "./useAdvancedDemo";

const GAPS = "Fill gaps from the recorder's noise gate";

function Host({
  selected,
  running,
  spy = {},
}: {
  selected?: string;
  running?: AdvancedStepsProps["running"];
  spy?: Partial<AdvancedStepsProps>;
}) {
  const none = {
    onSelect: vi.fn(),
    onBack: vi.fn(),
    onToggle: vi.fn(),
    onParam: vi.fn(),
    onReset: vi.fn(),
    onRunFromHere: vi.fn(),
    onCancel: vi.fn(),
    ...spy,
  };
  const demo = useAdvancedDemo(GROUPS, selected, none);
  return <AdvancedSteps {...none} {...demo} running={running} />;
}

describe("AdvancedSteps", () => {
  it("lists only the mapped steps, grouped like the Getting ready rows", () => {
    render(<Host />);
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual([
      "Transcribe",
      "Line up tracks",
      "Clean and level",
      "Find suggestions",
    ]);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("moves focus to the detail heading on select and back to the row on Back", async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole("button", { name: /^Line up tracks/ }));
    expect(
      screen.getByRole("heading", { level: 2, name: "Line up tracks" }),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Back to steps" }));
    expect(
      screen.getByRole("button", { name: /^Line up tracks/ }),
    ).toHaveFocus();
  });

  it("does not take focus when it opens on a step", () => {
    render(<Host selected="align" />);
    expect(document.body).toHaveFocus();
  });

  it("names the switch by the step and toggles it", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<Host spy={{ onToggle }} />);
    const gaps = screen.getByRole("switch", { name: GAPS });
    expect(gaps).toBeChecked();
    expect(gaps).toHaveAttribute("type", "checkbox");
    await user.click(gaps);
    expect(onToggle).toHaveBeenCalledWith("fill-gaps", false);
    expect(gaps).not.toBeChecked();
    expect(screen.queryByRole("switch", { name: "Line up tracks" })).toBeNull();
  });

  it("disables the switches with a written reason while a step runs", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<Host running={RUNNING} spy={{ onCancel }} />);
    const gaps = screen.getByRole("switch", { name: GAPS });
    expect(gaps).toBeDisabled();
    expect(gaps).toHaveAccessibleDescription(
      "Steps cannot change while one is running.",
    );
    expect(
      screen.getByRole("progressbar", { name: "Line up tracks" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("is a native slider read in plain units, so the arrow keys work in the browser", () => {
    const onParam = vi.fn();
    render(<Host selected="align" spy={{ onParam }} />);
    const slider = screen.getByRole("slider", { name: "Largest move" });
    expect(slider.tagName).toBe("INPUT");
    expect(slider).toHaveAttribute("type", "range");
    expect(slider).toHaveAttribute("step", "1");
    expect(slider).toHaveAttribute("aria-valuetext", "5 seconds");
    // jsdom has no key handling for a range, so the change a key makes is sent
    // directly; the story play function presses the real keys.
    fireEvent.change(slider, { target: { value: "6" } });
    expect(onParam).toHaveBeenLastCalledWith("align", "max-move", 6);
    expect(slider).toHaveAttribute("aria-valuetext", "6 seconds");
    fireEvent.change(slider, { target: { value: "1" } });
    expect(slider).toHaveAttribute("aria-valuetext", "1 second");
  });

  it("shows the reset button only when changed, named for the setting", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(<Host selected="fill-gaps" spy={{ onReset }} />);
    // The fixture starts this one off its default (2 seconds, default 1).
    const reset = screen.getByRole("button", {
      name: "Reset to default: Longest gap to fill",
    });
    expect(reset.tagName).toBe("BUTTON");
    await user.click(reset);
    expect(onReset).toHaveBeenCalledWith("fill-gaps", "longest-gap");
    expect(
      screen.queryByRole("button", { name: /^Reset to default/ }),
    ).toBeNull();
    expect(
      screen.getByRole("slider", { name: "Longest gap to fill" }),
    ).toHaveAttribute("aria-valuetext", "1 second");
  });

  it("describes each field by its help and offers language as a select", async () => {
    const user = userEvent.setup();
    render(<Host selected="transcribe" />);
    const language = screen.getByRole("combobox", { name: "Language" });
    expect(language).toHaveAccessibleDescription(/Detect automatically works/);
    expect(within(language).getAllByRole("option")[0]).toHaveTextContent(
      "Detect automatically",
    );
    await user.selectOptions(language, "es");
    expect(
      screen.getByRole("button", { name: "Reset to default: Language" }),
    ).toBeInTheDocument();
  });

  it("runs a step again from its own menu", async () => {
    const user = userEvent.setup();
    const onRunFromHere = vi.fn();
    render(<Host spy={{ onRunFromHere }} />);
    await user.click(
      screen.getByRole("button", { name: "More for Line up tracks" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Run again from here" }),
    );
    expect(onRunFromHere).toHaveBeenCalledWith("align");
  });

  it("moves focus to the setting's own control when Reset takes the dot away", async () => {
    const user = userEvent.setup();
    render(<Host selected="fill-gaps" />);
    screen
      .getByRole("button", { name: "Reset to default: Longest gap to fill" })
      .focus();
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("button", { name: /^Reset to default/ }),
    ).toBeNull();
    expect(
      screen.getByRole("slider", { name: "Longest gap to fill" }),
    ).toHaveFocus();
  });

  it("points the disabled setting controls at the busy reason too", () => {
    render(<Host selected="fill-gaps" running={RUNNING} />);
    const reason = "Steps cannot change while one is running.";
    expect(
      screen.getByRole("slider", { name: "Longest gap to fill" }),
    ).toHaveAccessibleDescription(new RegExp(reason));
    expect(
      screen.getByRole("button", {
        name: "Reset to default: Longest gap to fill",
      }),
    ).toHaveAccessibleDescription(reason);
  });

  describe("values it cannot trust", () => {
    const base = {
      onSelect: vi.fn(),
      onBack: vi.fn(),
      onToggle: vi.fn(),
      onParam: vi.fn(),
      onReset: vi.fn(),
      onRunFromHere: vi.fn(),
      onCancel: vi.fn(),
    };
    const scrub = (value: number) => ({
      kind: "scrub" as const,
      id: "p",
      label: "Largest move",
      help: "help",
      value,
      defaultValue: 5,
      min: 1,
      max: 30,
      step: 1,
      unit: ["second", "seconds"] as const,
    });
    const view = (
      param: AdvancedStepsProps["groups"][number]["steps"][number]["params"][number],
    ) => (
      <AdvancedSteps
        {...base}
        selectedId="s"
        groups={[
          {
            id: "g",
            title: "G",
            steps: [
              {
                id: "s",
                name: "Step",
                optional: false,
                enabled: true,
                params: [param],
              },
            ],
          },
        ]}
      />
    );

    it("reads a range value past the end as the end", () => {
      render(view(scrub(99)));
      const slider = screen.getByRole("slider", { name: "Largest move" });
      expect(slider).toHaveAttribute("aria-valuetext", "30 seconds");
      expect(screen.getByText("30 seconds")).toBeInTheDocument();
    });

    it("falls back to the default for a value that is not a number", () => {
      render(view(scrub(Number.NaN)));
      expect(
        screen.getByRole("slider", { name: "Largest move" }),
      ).toHaveAttribute("aria-valuetext", "5 seconds");
      expect(
        screen.queryByRole("button", { name: /^Reset to default/ }),
      ).toBeNull();
    });

    it("shows a value the list does not know as Custom, not as the first option", () => {
      render(
        view({
          kind: "language",
          id: "l",
          label: "Language",
          help: "help",
          value: "xx",
          defaultValue: "auto",
          options: [{ value: "auto", label: "Detect automatically" }],
        }),
      );
      const select = screen.getByRole("combobox", { name: "Language" });
      expect(select).toHaveDisplayValue("Custom (xx)");
      expect(
        within(select).getByRole("option", { name: "Custom (xx)" }),
      ).toBeDisabled();
    });
  });
});
