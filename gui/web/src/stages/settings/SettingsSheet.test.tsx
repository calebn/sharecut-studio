import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "../../hooks/useTheme";
import { expectNoA11yViolations } from "../../test/a11y";
import { SettingsSheet, type SettingsSheetProps } from "./SettingsSheet";

function setup(props: Partial<SettingsSheetProps> = {}) {
  const onModels = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <SettingsSheet
      form="end"
      open
      onClose={onClose}
      onModels={onModels}
      {...props}
    />,
  );
  return { ...view, onModels, onClose, user: userEvent.setup() };
}

afterEach(() => {
  window.localStorage.removeItem(THEME_STORAGE_KEY);
  delete document.documentElement.dataset.theme;
});

describe("SettingsSheet", () => {
  it("opens Models", async () => {
    const { user, onModels } = setup();
    await user.click(screen.getByRole("button", { name: /^Models/ }));
    expect(onModels).toHaveBeenCalledOnce();
  });

  it("applies the appearance as it is chosen and remembers it", async () => {
    const { user } = setup();
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("shows no Saved in while no episode is open", () => {
    setup();
    expect(screen.queryByText("Saved in")).toBeNull();
  });

  it("names the folder the episode is saved in", () => {
    setup({ projectFolder: "/Users/maya/ShareCut/Ep 14" });
    expect(screen.getByText("Saved in")).toBeInTheDocument();
    expect(screen.getByText("/Users/maya/ShareCut/Ep 14")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reveal in folder" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Move…" })).toBeNull();
  });

  it("moves the folder where the app can", async () => {
    const onMoveFolder = vi.fn();
    const { user } = setup({ projectFolder: "/ep", onMoveFolder });
    await user.click(screen.getByRole("button", { name: "Move…" }));
    expect(onMoveFolder).toHaveBeenCalledOnce();
  });

  it("docks to the end edge at 400 px on desktop", () => {
    setup();
    expect(
      document.querySelector(".sys-sheet-end.settings-sheet"),
    ).not.toBeNull();
  });

  it("reveals the folder where the app can", async () => {
    const onRevealFolder = vi.fn();
    const { user } = setup({ projectFolder: "/ep", onRevealFolder });
    await user.click(screen.getByRole("button", { name: "Reveal in folder" }));
    expect(onRevealFolder).toHaveBeenCalledOnce();
  });

  it("opens the shortcuts reference only where there is one", async () => {
    const first = setup();
    expect(
      screen.queryByRole("button", { name: /Keyboard shortcuts/ }),
    ).toBeNull();
    first.unmount();
    const onShortcuts = vi.fn();
    const { user } = setup({ onShortcuts });
    await user.click(
      screen.getByRole("button", { name: /Keyboard shortcuts/ }),
    );
    expect(onShortcuts).toHaveBeenCalledOnce();
  });

  it("has no accessibility violations", async () => {
    const { baseElement } = setup({
      projectFolder: "/ep",
      onRevealFolder: vi.fn(),
      onMoveFolder: vi.fn(),
      onShortcuts: vi.fn(),
    });
    await expectNoA11yViolations(baseElement);
  });
});
