import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { StageBar } from "./StageBar";

// ui.css scales a pressed `.ui-control`. A tab shares its edges with its
// neighbours, so a scale would move its hit edge and lose the click; the tabs
// keep a colour-only press by not being `.ui-control`s at all.
it.each(["bar", "tabs"] as const)(
  "the %s form's tabs are not press-scaled controls",
  (form) => {
    render(<StageBar active="edit" onSelect={vi.fn()} form={form} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    for (const tab of tabs) {
      expect(tab.classList.contains("ui-control")).toBe(false);
      expect(tab.closest(".ui-control")).toBeNull();
    }
  },
);
