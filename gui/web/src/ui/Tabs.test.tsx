import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
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
