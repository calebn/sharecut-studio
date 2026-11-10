import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
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
  it("names the session lifetime and restart reset, and points to Skip", () => {
    render(<Host />);
    expect(
      screen.getByText(
        "These switches affect runs started here for this episode until ShareCut restarts. After a restart, the steps return to their defaults. Use Skip in the plan to change one run.",
      ),
    ).toBeVisible();
  });

  it("lists Apply sound actions second under Find suggestions, off, with a switch", () => {
    render(<Host />);
    expect(
      screen.queryByRole("region", { name: "Listen for sounds" }),
    ).toBeNull();
    const group = screen.getByRole("region", { name: "Find suggestions" });
    expect(
      within(group)
        .getAllByRole("switch")
        .map((s) => s.getAttribute("aria-label") ?? s.textContent),
    ).toEqual(["Find fillers and pauses", "Apply sound actions"]);
    expect(
      within(group).getByRole("switch", { name: "Apply sound actions" }),
    ).not.toBeChecked();
  });

  it("turns the scan on from its switch", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<Host spy={{ onToggle }} />);
    await user.click(
      screen.getByRole("switch", { name: "Apply sound actions" }),
    );
    expect(onToggle).toHaveBeenCalledWith("apply_sound_actions", true);
  });

  it("shows the scan's cost and help, and the person's own start choice", async () => {
    const user = userEvent.setup();
    render(<Host selected="apply_sound_actions" />);
    expect(
      screen.getByText(
        "Off. Can take about 2½ minutes for 30 minutes of audio when analysis is needed.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/Applies suggested sound actions during processing/),
    ).toBeVisible();
    const group = screen.getByRole("group", {
      name: "New projects start with this",
    });
    expect(
      screen.getByText(
        "Saved in this browser for new episodes. This episode's switch resets to its default when ShareCut restarts.",
      ),
    ).toBeVisible();
    const off = within(group).getByRole("button", { name: "Off" });
    const on = within(group).getByRole("button", { name: "On" });
    expect(off).toHaveAttribute("aria-pressed", "true");
    await user.click(on);
    expect(on).toHaveAttribute("aria-pressed", "true");
    expect(off).toHaveAttribute("aria-pressed", "false");
  });

  it("moves the cost line with the switch instead of keeping the Off hint", async () => {
    const user = userEvent.setup();
    render(<Host selected="apply_sound_actions" />);
    expect(screen.getByText(/^Off\. Can take about/)).toBeVisible();
    await user.click(
      screen.getByRole("switch", { name: "Apply sound actions" }),
    );
    expect(screen.queryByText(/^Off\./)).toBeNull();
    expect(
      screen.getByText(
        "Can take about 2½ minutes for 30 minutes of audio when analysis is needed.",
      ),
    ).toBeVisible();
  });

  it("passes the person's choice on, apart from the project's switch", async () => {
    const user = userEvent.setup();
    const onPersonal = vi.fn();
    const onToggle = vi.fn();
    render(
      <Host selected="apply_sound_actions" spy={{ onPersonal, onToggle }} />,
    );
    await user.click(screen.getByRole("button", { name: "On" }));
    expect(onPersonal).toHaveBeenCalledWith("apply_sound_actions", true);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("keeps the personal choice off the other steps", () => {
    render(<Host selected="fillers" />);
    expect(
      screen.queryByRole("group", { name: "New projects start with this" }),
    ).toBeNull();
  });

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
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
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

  it("holds the switches with a written reason while a step runs", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onToggle = vi.fn();
    render(<Host running={RUNNING} spy={{ onCancel, onToggle }} />);
    const gaps = screen.getByRole("switch", { name: GAPS });
    expect(gaps).toHaveAttribute("aria-disabled", "true");
    await user.click(gaps);
    expect(onToggle).not.toHaveBeenCalled();
    expect(gaps).toBeChecked();
    expect(gaps).toHaveAccessibleDescription(
      "Steps cannot change while one is running.",
    );
    expect(
      screen.getByRole("progressbar", { name: "Line up tracks" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it.each([
    ["list", undefined],
    ["detail", "align"],
  ])(
    "keeps focus off the page when Cancel goes away in the %s view",
    async (_, selected) => {
      const user = userEvent.setup();
      function Cancelable() {
        const [running, setRunning] =
          useState<AdvancedStepsProps["running"]>(RUNNING);
        return (
          <Host
            selected={selected}
            running={running}
            spy={{ onCancel: () => setRunning(undefined) }}
          />
        );
      }
      render(<Cancelable />);
      const cancel = screen.getByRole("button", { name: "Cancel" });
      cancel.focus();
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 2 }),
      );
    },
  );

  it("reads a fractional value without float noise", () => {
    const groups = GROUPS.map((group) => ({
      ...group,
      steps: group.steps.map((step) => ({
        ...step,
        params: step.params.map((param) =>
          param.kind === "scrub"
            ? { ...param, min: 0, max: 1, step: 0.1, value: 0.1 + 0.2 }
            : param,
        ),
      })),
    }));
    function Noise() {
      const spy = {
        onSelect: vi.fn(),
        onBack: vi.fn(),
        onToggle: vi.fn(),
        onParam: vi.fn(),
        onReset: vi.fn(),
        onRunFromHere: vi.fn(),
        onCancel: vi.fn(),
      };
      const demo = useAdvancedDemo(groups, "align", spy);
      return <AdvancedSteps {...demo} />;
    }
    render(<Noise />);
    expect(screen.getByRole("spinbutton")).toHaveAttribute(
      "aria-valuetext",
      "0.3 seconds",
    );
  });

  it("is a scrub field read in plain units, with no native range slider", async () => {
    const user = userEvent.setup();
    const onParam = vi.fn();
    const { container } = render(<Host selected="align" spy={{ onParam }} />);
    expect(container.querySelector('input[type="range"]')).toBeNull();
    const field = screen.getByRole("spinbutton", { name: "Largest move" });
    expect(field).toHaveAttribute("aria-valuemin", "1");
    expect(field).toHaveAttribute("aria-valuemax", "30");
    expect(field).toHaveAttribute("aria-valuetext", "5 seconds");
    field.focus();
    await user.keyboard("{ArrowUp}");
    expect(onParam).toHaveBeenLastCalledWith("align", "max-move", 6);
    expect(
      screen.getByRole("spinbutton", { name: "Largest move" }),
    ).toHaveAttribute("aria-valuetext", "6 seconds");
    await user.keyboard(
      "{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Largest move" }),
    ).toHaveAttribute("aria-valuetext", "1 second");
  });

  it("commits a typed value", async () => {
    const user = userEvent.setup();
    const onParam = vi.fn();
    render(<Host selected="align" spy={{ onParam }} />);
    screen.getByRole("spinbutton", { name: "Largest move" }).focus();
    await user.keyboard("{Enter}");
    await user.keyboard("12{Enter}");
    expect(onParam).toHaveBeenLastCalledWith("align", "max-move", 12);
  });

  it("shows the scrub reset dot only when changed, and the dot resets", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(<Host selected="fill-gaps" spy={{ onReset }} />);
    const reset = screen.getByRole("button", {
      name: /^Reset Longest gap to fill to 1/,
    });
    await user.click(reset);
    expect(onReset).toHaveBeenCalledWith("fill-gaps", "longest-gap");
    expect(
      screen.queryByRole("button", { name: /^Reset Longest gap/ }),
    ).toBeNull();
    expect(
      screen.getByRole("spinbutton", { name: "Longest gap to fill" }),
    ).toHaveAttribute("aria-valuetext", "1 second");
  });

  it("offers language as a searchable picker with Detect automatically first", async () => {
    const user = userEvent.setup();
    const onParam = vi.fn();
    render(<Host selected="transcribe" spy={{ onParam }} />);
    const language = screen.getByRole("combobox", { name: "Language" });
    expect(language).toHaveAccessibleDescription(/Detect automatically works/);
    expect(language).toHaveValue("Detect automatically");
    language.focus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(language);
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Detect automatically");
    expect(options).toHaveLength(100);
    await user.keyboard("ukr");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Ukrainian",
    ]);
    await user.keyboard("{Enter}");
    expect(onParam).toHaveBeenCalledWith("transcribe", "language", "uk");
    expect(
      screen.getByRole("button", { name: "Reset to default: Language" }),
    ).toBeInTheDocument();
    expect(language).toHaveValue("Ukrainian");
  });

  it("has no axe violations with the scrub field and the open language picker", async () => {
    const user = userEvent.setup();
    const align = render(<Host selected="align" />);
    await expectNoA11yViolations(align.container);
    align.unmount();
    const language = render(<Host selected="transcribe" />);
    await user.click(screen.getByRole("combobox", { name: "Language" }));
    await expectNoA11yViolations(language.container);
  });

  it("finds a language by its code and says when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Host selected="transcribe" />);
    const language = screen.getByRole("combobox", { name: "Language" });
    await user.click(language);
    await user.keyboard("pt");
    expect(screen.getByRole("option", { name: "Portuguese" })).toBeVisible();
    await user.clear(language);
    await user.keyboard("zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No language matches")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(language).toHaveValue("Detect automatically");
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
      .getByRole("button", { name: /^Reset Longest gap to fill to 1/ })
      .focus();
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("button", { name: /^Reset Longest gap/ }),
    ).toBeNull();
    expect(
      screen.getByRole("spinbutton", { name: "Longest gap to fill" }),
    ).toHaveFocus();
  });

  it("points a held setting at the busy reason and refuses changes", async () => {
    const user = userEvent.setup();
    const onParam = vi.fn();
    const onReset = vi.fn();
    const { rerender } = render(
      <Host selected="fill-gaps" spy={{ onParam, onReset }} />,
    );
    const field = screen.getByRole("spinbutton", {
      name: "Longest gap to fill",
    });
    field.focus();
    rerender(
      <Host
        selected="fill-gaps"
        running={RUNNING}
        spy={{ onParam, onReset }}
      />,
    );
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("aria-readonly", "true");
    expect(field).toHaveAccessibleDescription(
      /Steps cannot change while one is running\./,
    );
    await user.keyboard("{ArrowUp}");
    expect(onParam).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("holds the language picker while a step runs", async () => {
    const user = userEvent.setup();
    const onParam = vi.fn();
    render(<Host selected="transcribe" running={RUNNING} spy={{ onParam }} />);
    const language = screen.getByRole("combobox", { name: "Language" });
    expect(language).toHaveAttribute("aria-disabled", "true");
    await user.click(language);
    await user.click(screen.getByRole("option", { name: "Spanish" }));
    expect(onParam).not.toHaveBeenCalled();
  });

  it("keeps focus on a list switch when a step starts running", () => {
    const { rerender } = render(<Host />);
    const gaps = screen.getByRole("switch", { name: GAPS });
    gaps.focus();
    rerender(<Host running={RUNNING} />);
    expect(gaps).toHaveFocus();
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
      const field = screen.getByRole("spinbutton", { name: "Largest move" });
      expect(field).toHaveAttribute("aria-valuetext", "30 seconds");
      expect(field).toHaveTextContent("30");
    });

    it("falls back to the default for a value that is not a number", () => {
      render(view(scrub(Number.NaN)));
      expect(
        screen.getByRole("spinbutton", { name: "Largest move" }),
      ).toHaveAttribute("aria-valuetext", "5 seconds");
      expect(
        screen.queryByRole("button", { name: /^Reset to default/ }),
      ).toBeNull();
    });

    it("shows a saved code the list does not know as that code", () => {
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
      expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue(
        "xx",
      );
    });
  });
});
