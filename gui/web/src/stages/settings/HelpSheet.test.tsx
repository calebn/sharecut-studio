import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { HelpSheet, type HelpSheetProps } from "./HelpSheet";
import { BUNDLE, DESCRIBED } from "./settingsFixtures";

function setup(props: Partial<HelpSheetProps> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onStepChange: vi.fn(),
    onShortcuts: vi.fn(),
    onDescriptionChange: vi.fn(),
    onTogglePreview: vi.fn(),
    onSend: vi.fn(),
    onCopyReference: vi.fn(async () => true),
  };
  const view = render(
    <HelpSheet
      form="centered"
      open
      step="menu"
      description=""
      preview={{ kind: "closed" }}
      phase={{ kind: "editing" }}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...view, user: userEvent.setup() };
}

const dialog = () => screen.getByRole("dialog");

describe("HelpSheet menu", () => {
  it("lists Shortcuts and gestures, Report a problem and Guides", () => {
    setup();
    const rows = dialog().querySelectorAll(".set-row");
    expect([...rows].map((row) => row.textContent)).toEqual([
      "Shortcuts and gestures",
      "Report a problem",
      "Guides",
    ]);
  });

  it("opens the Palette from Shortcuts and gestures", async () => {
    const { user, onShortcuts } = setup();
    await user.click(
      screen.getByRole("button", { name: "Shortcuts and gestures" }),
    );
    expect(onShortcuts).toHaveBeenCalledOnce();
  });

  it("leaves the shortcuts row out where there is no Palette", () => {
    setup({ onShortcuts: undefined });
    expect(
      screen.queryByRole("button", { name: "Shortcuts and gestures" }),
    ).toBeNull();
  });

  it("opens Guides in a new tab", () => {
    setup();
    const guides = screen.getByRole("link", { name: "Guides" });
    expect(guides).toHaveAttribute("href", "https://ux.sharecut.studio/");
    expect(guides).toHaveAttribute("target", "_blank");
  });

  it("pushes Report a problem inside the same sheet", async () => {
    const { user, onStepChange } = setup();
    await user.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(onStepChange).toHaveBeenCalledWith("report");
  });

  it("has no accessibility violations", async () => {
    const { baseElement } = setup();
    await expectNoA11yViolations(baseElement);
  });
});

describe("HelpSheet report", () => {
  it("names what the report holds and keeps Send report waiting for a description", () => {
    setup({ step: "report", blockedReason: "Describe the problem first." });
    expect(
      screen.getByRole("dialog", { name: "Report a problem" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Includes logs and settings. No audio, transcripts or project files.",
      ),
    ).toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Send report" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription("Describe the problem first.");
    expect(screen.getByText("Describe the problem first.")).toBeVisible();
  });

  it("goes back to the menu with Back", async () => {
    const { user, onStepChange } = setup({ step: "report" });
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onStepChange).toHaveBeenCalledWith("menu");
  });

  it("sends the described report", async () => {
    const { user, onSend } = setup({
      step: "report",
      description: DESCRIBED,
    });
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("asks for the preview and lists the files once it is ready", async () => {
    const { user, onTogglePreview, rerender } = setup({ step: "report" });
    const toggle = screen.getByRole("button", {
      name: "Preview what's included",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(onTogglePreview).toHaveBeenCalledOnce();
    rerender(
      <HelpSheet
        form="centered"
        open
        step="report"
        description=""
        preview={{ kind: "ready", bundle: BUNDLE }}
        phase={{ kind: "editing" }}
        onClose={vi.fn()}
        onStepChange={vi.fn()}
        onDescriptionChange={vi.fn()}
        onTogglePreview={onTogglePreview}
        onSend={vi.fn()}
        onCopyReference={vi.fn()}
      />,
    );
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("logs/studio.log")).toBeInTheDocument();
    expect(screen.getByText(/5 files, 47\.2 KB/)).toBeInTheDocument();
  });

  it("shows a progress row while sending", () => {
    setup({ step: "report", phase: { kind: "sending" } });
    expect(screen.getByText("Sending the report…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send report" })).toBeNull();
  });

  it("says Sent with the reference and copies it", async () => {
    const { user, onCopyReference } = setup({
      step: "report",
      phase: { kind: "sent", reference: "R-2481" },
    });
    expect(screen.getByText("Sent.")).toBeInTheDocument();
    expect(screen.getByText("Reference R-2481")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy reference" }));
    expect(onCopyReference).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toHaveTextContent("Copied");
    await user.click(screen.getByRole("button", { name: "Done" }));
  });

  it("says a queued report is saved here and sends when online", () => {
    setup({ step: "report", phase: { kind: "queued" } });
    expect(screen.getByText("Saved on this computer.")).toBeInTheDocument();
    expect(
      screen.getByText("It sends when you're online."),
    ).toBeInTheDocument();
  });

  it("points a saved report with no relay at support", () => {
    setup({
      step: "report",
      phase: {
        kind: "saved",
        path: BUNDLE.path,
        supportHref: "https://support.example.test",
      },
    });
    expect(screen.getByText(BUNDLE.path)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open support" })).toHaveAttribute(
      "href",
      "https://support.example.test",
    );
  });

  it("keeps the description and offers Try again after a failure", async () => {
    const { user, onSend } = setup({
      step: "report",
      description: DESCRIBED,
      phase: { kind: "failed", reason: "report relay unavailable" },
    });
    expect(screen.getByText("Couldn't send the report.")).toBeInTheDocument();
    expect(screen.getByLabelText("What went wrong?")).toHaveValue(DESCRIBED);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("has no accessibility violations on the report step", async () => {
    const { baseElement } = setup({
      step: "report",
      description: DESCRIBED,
      preview: { kind: "ready", bundle: BUNDLE },
    });
    await expectNoA11yViolations(baseElement);
  });

  it("has no accessibility violations once sent", async () => {
    const { baseElement } = setup({
      step: "report",
      phase: { kind: "sent", reference: "R-2481" },
    });
    await expectNoA11yViolations(baseElement);
  });

  it("is a bottom sheet on a phone", () => {
    setup({ form: "bottom" });
    expect(dialog()).toBeInTheDocument();
  });
});
