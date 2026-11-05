import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { SettingsSheet, type SettingsSheetProps } from "./SettingsSheet";

function setup(props: Partial<SettingsSheetProps> = {}) {
  const onModels = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <SettingsSheet
      form="centered"
      open
      onClose={onClose}
      onModels={onModels}
      {...props}
    />,
  );
  return { ...view, onModels, onClose, user: userEvent.setup() };
}

describe("SettingsSheet", () => {
  it("holds only Models while no episode is open", async () => {
    const { user, onModels } = setup();
    expect(
      screen.queryByRole("button", { name: /Project settings/ }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Models/ }));
    expect(onModels).toHaveBeenCalledOnce();
  });

  it("pushes Project settings to show where the episode is saved", async () => {
    const { user } = setup({ projectFolder: "/Users/maya/ShareCut/Ep 14" });
    await user.click(screen.getByRole("button", { name: /Project settings/ }));
    expect(
      screen.getByRole("dialog", { name: "Project settings" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Saved in")).toBeInTheDocument();
    expect(screen.getByText("/Users/maya/ShareCut/Ep 14")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { baseElement } = setup({ projectFolder: "/ep" });
    await expectNoA11yViolations(baseElement);
  });
});
