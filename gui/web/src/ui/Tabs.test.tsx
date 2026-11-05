import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Tab, TabList } from "./Tabs";

const IDS = ["one", "two", "three"] as const;

function Harness() {
  const [active, setActive] = useState<(typeof IDS)[number]>("one");
  return (
    <div>
      <TabList label="Panels">
        {IDS.map((id) => (
          <Tab
            key={id}
            id={`tab-${id}`}
            panelId="panel"
            selected={active === id}
            onClick={() => setActive(id)}
          >
            {id}
          </Tab>
        ))}
      </TabList>
      <div role="tabpanel" id="panel" aria-labelledby={`tab-${active}`}>
        {active}
      </div>
    </div>
  );
}

describe("TabList", () => {
  it("forwards programmatic container focus to the selected tab without selecting another", async () => {
    render(
      <>
        <Harness />
        <button type="button">After panels</button>
      </>,
    );
    await userEvent.click(screen.getByRole("tab", { name: "two" }));
    act(() => screen.getByRole("button", { name: "After panels" }).focus());
    act(() => screen.getByRole("tablist").focus());
    expect(screen.getByRole("tab", { name: "two" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "three" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "After panels" })).toHaveFocus();
  });

  it("forwards padding clicks to the selected tab without adding a tab stop", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("tablist"));
    expect(screen.getByRole("tab", { name: "one" })).toHaveFocus();
    expect(screen.getByRole("tablist")).toHaveAttribute("tabindex", "-1");
    act(() => screen.getByRole("tab", { name: "three" }).focus());
    expect(screen.getByRole("tab", { name: "three" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "one" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("skips disabled tabs while moving from a focused enabled tab", async () => {
    const select = vi.fn();
    render(
      <TabList label="Available panels">
        <Tab selected panelId="panel">
          First
        </Tab>
        <Tab selected={false} disabled panelId="panel">
          Unavailable
        </Tab>
        <Tab selected={false} panelId="panel" onClick={select}>
          Next
        </Tab>
      </TabList>,
    );
    await userEvent.tab();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Next" })).toHaveFocus();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("falls back to the first enabled tab without issuing a selection command", () => {
    const select = vi.fn();
    render(
      <TabList label="Unavailable selection">
        <Tab selected disabled panelId="panel" onClick={select}>
          Unavailable
        </Tab>
        <Tab selected={false} panelId="panel" onClick={select}>
          Available
        </Tab>
      </TabList>,
    );
    act(() => screen.getByRole("tablist").focus());
    expect(screen.getByRole("tab", { name: "Available" })).toHaveFocus();
    expect(select).not.toHaveBeenCalled();
  });

  it("is axe-clean and exposes one tab stop", async () => {
    const { container } = render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Panels" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "one" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "two" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    await expectNoA11yViolations(container);
  });

  it("moves from the selected tab to the next control without stopping on the tablist", async () => {
    render(
      <>
        <Harness />
        <button type="button">After panels</button>
      </>,
    );
    await userEvent.tab();
    expect(screen.getByRole("tab", { name: "one" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "two" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "After panels" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("tab", { name: "two" })).toHaveFocus();
  });

  it("moves selection with arrows, Home and End", async () => {
    render(<Harness />);
    await userEvent.tab();
    expect(screen.getByRole("tab", { name: "one" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "two" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("two");
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "three" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "one" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "three" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "one" })).toHaveFocus();
  });
});
