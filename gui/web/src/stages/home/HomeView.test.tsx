import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StartTile } from "../../system/StartTile";
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
      name: /^Rosa and Maya, week 42/,
    });
    first.focus();
    await user.keyboard("{Enter}");
    expect(onOpenProject).toHaveBeenCalledWith("rosa", "review");
  });

  it("keeps focus where the person put it when the list arrives", () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    setup({ autoFocusPrimary: true });
    expect(field).toHaveFocus();
    field.remove();
  });

  it("skips a folder-missing card when it takes focus on load", () => {
    setup({
      autoFocusPrimary: true,
      projects: [
        { ...RECENTS[0], id: "gone", name: "Gone", folderMissing: true },
        ...RECENTS.slice(1),
      ],
    });
    expect(screen.getByRole("button", { name: /^Gone/ })).not.toHaveFocus();
    expect(document.activeElement?.hasAttribute("data-project-open")).toBe(
      true,
    );
    expect(document.activeElement).not.toHaveAttribute("aria-disabled");
  });

  it("says a failed read in words and tries again", async () => {
    const onRetryLoad = vi.fn();
    const { user } = setup({ phase: "error", projects: [], onRetryLoad });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load your episodes.",
    );
    expect(
      screen.getByRole("button", { name: /^Import audio/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryLoad).toHaveBeenCalledOnce();
  });

  it("focuses the first card on load only when asked", () => {
    setup({ autoFocusPrimary: true });
    expect(
      screen.getByRole("button", { name: /^Rosa and Maya, week 42/ }),
    ).toHaveFocus();
  });

  it("starts an episode from the Import and Record tiles", async () => {
    const { user, onImport, onRecord } = setup();
    await user.click(screen.getByRole("button", { name: /^Import audio/ }));
    await user.click(screen.getByRole("button", { name: /^Record/ }));
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

  it("shows the working line beside the Recent heading and marks the card opening", () => {
    setup({ working: "Opening…", busyId: RECENTS[0].id });
    const head = screen.getByRole("heading", { name: "Recent" }).parentElement;
    expect(head).toContainElement(screen.getByText("Opening…"));
    expect(screen.getByText("Opening…")).toHaveRole("status");
    const busy = screen
      .getAllByRole("button")
      .filter((card) => card.getAttribute("aria-busy") === "true");
    expect(busy).toHaveLength(1);
    expect(busy[0]).toHaveAccessibleName(new RegExp(`^${RECENTS[0].name}`));
  });

  it("styles the audio tools guide link as a sys- text button", () => {
    setup({ setup: { state: "tools-missing", sizeLabel: "" } });
    expect(
      screen.getByRole("link", { name: "Setup guide for the audio tools" }),
    ).toHaveClass("sys-text-btn");
  });

  it("stays quiet when nothing is dragged", () => {
    setup();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

describe("HomeView empty, loading and drop", () => {
  it("makes Import audio the filled primary tile only when empty", () => {
    setup({ phase: "empty", projects: [] });
    expect(screen.getByRole("button", { name: /^Import audio/ })).toHaveClass(
      "sys-start--primary",
    );
    expect(screen.getByRole("button", { name: /^Record/ })).not.toHaveClass(
      "sys-start--primary",
    );
  });

  it("keeps Import audio default when there are recents", () => {
    setup();
    expect(
      screen.getByRole("button", { name: /^Import audio/ }),
    ).not.toHaveClass("sys-start--primary");
  });

  it("has one h1, the ShareCut wordmark", () => {
    setup();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "ShareCut",
    );
  });

  it("calls onRetryLoad from the slow skeleton", async () => {
    const onRetryLoad = vi.fn();
    const { user } = setup({
      phase: "loading",
      projects: [],
      loadingElapsedMs: 5000,
      onRetryLoad,
    });
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryLoad).toHaveBeenCalledOnce();
  });

  it("words the drop with the dragged file count", () => {
    setup({ dropActive: true, dropCount: 3 });
    expect(screen.getByText("Drop to add 3 files")).toBeInTheDocument();
  });

  it("words the drop without a count", () => {
    setup({ dropActive: true });
    expect(screen.getByText("Drop to add files")).toBeInTheDocument();
  });
});

describe("HomeView start tiles", () => {
  it("shows no shortcut hints, since Home binds no keys for them", () => {
    for (const props of [{}, { phase: "empty" as const, projects: [] }]) {
      setup(props);
      for (const name of [/^Import audio/, /^Record/]) {
        expect(
          screen.getByRole("button", { name }).querySelector(".sys-keys"),
        ).toBeNull();
      }
      cleanup();
    }
  });
});

describe("StartTile keys", () => {
  it("keeps the key caps by default and hides them with showKeys off", () => {
    const { rerender } = render(
      <StartTile kind="import" size={240} onActivate={vi.fn()} />,
    );
    expect(document.querySelector(".sys-keys")).not.toBeNull();
    rerender(
      <StartTile
        kind="import"
        size={240}
        showKeys={false}
        onActivate={vi.fn()}
      />,
    );
    expect(document.querySelector(".sys-keys")).toBeNull();
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
      />,
    );
    await user.click(
      screen.getByRole("textbox", { name: "Folder of the episode" }),
    );
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  const renderOpen = () => {
    render(
      <OpenOther
        mode="path"
        path="/ep"
        defaultOpen
        onChooseFolder={vi.fn()}
        onPathChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    return userEvent.setup();
  };

  it("closes on Esc from the field and focuses the trigger", async () => {
    const user = await renderOpen();
    await user.click(
      screen.getByRole("textbox", { name: "Folder of the episode" }),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open other…" })).toHaveFocus();
  });

  it("closes on Esc from the Open button and focuses the trigger", async () => {
    const user = await renderOpen();
    screen.getByRole("button", { name: "Open" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open other…" })).toHaveFocus();
  });
});

describe("OpenOther mode flip", () => {
  const props = {
    path: "",
    onChooseFolder: vi.fn(),
    onPathChange: vi.fn(),
    onSubmit: vi.fn(),
  };

  it("keeps the trigger mounted, opens the field and focuses it", () => {
    const { rerender } = render(<OpenOther mode="picker" {...props} />);
    const trigger = screen.getByRole("button", { name: "Open other…" });
    trigger.focus();
    rerender(<OpenOther mode="path" {...props} />);
    expect(screen.getByRole("button", { name: "Open other…" })).toBe(trigger);
    expect(
      screen.getByRole("textbox", { name: "Folder of the episode" }),
    ).toHaveFocus();
  });
});

describe("StartTile size 80", () => {
  it("renders a disabled reason as part of the tile name", () => {
    render(
      <StartTile
        kind="record"
        size={80}
        state="disabled"
        disabledReason="Finish the current save first."
        onActivate={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Record/ }),
    ).toHaveAccessibleName(/Finish the current save first\./);
    expect(screen.getByText("Finish the current save first.")).toBeVisible();
  });
});
