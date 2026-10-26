import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomeView, type HomeViewProps } from "./HomeView";
import { RECENTS } from "./homeFixture";
import { OpenOther } from "./OpenOther";

function setup(props: Partial<HomeViewProps> = {}) {
  const handlers = {
    onOpenProject: vi.fn(),
    onFindProject: vi.fn(),
    onImport: vi.fn(),
    onRecord: vi.fn(),
    onOpenOther: vi.fn(),
    onGetReady: vi.fn(),
    onChooseModels: vi.fn(),
    onCancelSetup: vi.fn(),
    onRetrySetup: vi.fn(),
    onDismissSetup: vi.fn(),
    onDismissHint: vi.fn(),
    onHelp: vi.fn(),
    onModels: vi.fn(),
    onConnectAgent: vi.fn(),
    onSettings: vi.fn(),
  };
  render(
    <HomeView
      phase="ready"
      projects={RECENTS}
      setup={null}
      showInstallHint={false}
      dropActive={false}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, user: userEvent.setup() };
}

describe("HomeView", () => {
  it("opens the focused primary card at its stage with Enter", async () => {
    const { user, onOpenProject } = setup();
    await user.tab();
    await user.tab();
    await user.tab();
    const first = screen.getByRole("button", {
      name: "Rosa and Maya, week 42",
    });
    first.focus();
    await user.keyboard("{Enter}");
    expect(onOpenProject).toHaveBeenCalledWith("rosa", "review");
  });

  it("focuses the first card on load only when asked", () => {
    setup({ autoFocusPrimary: true });
    expect(
      screen.getByRole("button", { name: "Rosa and Maya, week 42" }),
    ).toHaveFocus();
  });

  it("starts an episode from the Import and Record tiles", async () => {
    const { user, onImport, onRecord } = setup();
    await user.click(screen.getByRole("button", { name: "Import audio" }));
    await user.click(screen.getByRole("button", { name: "Record" }));
    expect(onImport).toHaveBeenCalledOnce();
    expect(onRecord).toHaveBeenCalledOnce();
  });

  it("dismisses the Setup card from its more menu", async () => {
    const { user, onDismissSetup } = setup({
      setup: { state: "needed", sizeLabel: "about 2 GB" },
    });
    await user.click(screen.getByRole("button", { name: "More about setup" }));
    await user.click(screen.getByRole("menuitem", { name: "Not now" }));
    expect(onDismissSetup).toHaveBeenCalledOnce();
  });

  it("dismisses the install hint", async () => {
    const { user, onDismissHint } = setup({ showInstallHint: true });
    await user.click(
      screen.getByRole("button", { name: "Dismiss: Add to Home Screen hint" }),
    );
    expect(onDismissHint).toHaveBeenCalledOnce();
  });

  it("announces the drop in a polite live region", () => {
    setup({ dropActive: true });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Drop to start an episode",
    );
  });

  it("stays quiet when nothing is dragged", () => {
    setup();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

describe("OpenOther", () => {
  it("submits the path with Enter", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <OpenOther
        mode="path"
        path="/ep"
        defaultOpen
        onChooseFolder={vi.fn()}
        onPathChange={vi.fn()}
        onSubmit={onSubmit}
        onSwitchWindow={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("textbox", { name: "Folder of the episode" }),
    );
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
