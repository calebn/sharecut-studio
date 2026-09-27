import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { SRC_ROOT } from "../test/sourceFiles";
import { BounceDialogView } from "./BounceDialogView";

function baseProps(): Parameters<typeof BounceDialogView>[0] {
  return {
    open: true,
    onClose: vi.fn(),
    source: "entire",
    onSourceChange: vi.fn(),
    selectedCount: 2,
    soloCount: 1,
    hasRegion: true,
    useRegion: false,
    onUseRegionChange: vi.fn(),
    includeMp3: false,
    onIncludeMp3Change: vi.fn(),
    busy: false,
    error: null,
    onBounce: vi.fn(),
  };
}

describe("BounceDialogView", () => {
  it("renders production source options from props; axe-clean", async () => {
    const props = baseProps();
    const { container } = render(<BounceDialogView {...props} />);
    expect(screen.getByLabelText("Entire mix")).toBeInTheDocument();
    expect(screen.getByLabelText("Selected tracks (2)")).toBeInTheDocument();
    expect(screen.getByLabelText("Soloed tracks (1)")).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("reports every control through its callback", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<BounceDialogView {...props} />);

    await user.click(screen.getByLabelText("Selected tracks (2)"));
    expect(props.onSourceChange).toHaveBeenCalledWith("selected");

    await user.click(screen.getByLabelText("Also write MP3"));
    expect(props.onIncludeMp3Change).toHaveBeenCalledWith(true);

    await user.click(screen.getByLabelText(/Limit to session region/));
    expect(props.onUseRegionChange).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Bounce" }));
    expect(props.onBounce).toHaveBeenCalledOnce();
  });

  it("disables the region checkbox when there is no region", () => {
    const props = baseProps();
    props.hasRegion = false;
    render(<BounceDialogView {...props} />);
    expect(
      screen.getByLabelText(/Limit to session region \(no region set\)/),
    ).toBeDisabled();
  });

  it("shows a busy Bounce button as disabled", () => {
    const props = baseProps();
    props.busy = true;
    render(<BounceDialogView {...props} />);
    const button = screen.getByRole("button", { name: "Bouncing…" });
    expect(button).toBeDisabled();
  });

  it("shows an error", () => {
    const props = baseProps();
    props.error = "Select one or more tracks first";
    render(<BounceDialogView {...props} />);
    expect(
      screen.getByText("Select one or more tracks first"),
    ).toBeInTheDocument();
  });

  it("gives two instances distinct radio group names", () => {
    const propsA = baseProps();
    const propsB = baseProps();
    render(
      <div>
        <BounceDialogView {...propsA} />
        <BounceDialogView {...propsB} />
      </div>,
    );
    const radios = screen.getAllByLabelText("Entire mix") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios[0].name).not.toBe(radios[1].name);
  });

  it("renders nothing when closed", () => {
    const props = baseProps();
    props.open = false;
    render(<BounceDialogView {...props} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has no import on store, api or command modules", () => {
    const source = readFileSync(
      join(SRC_ROOT, "layout/BounceDialogView.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/from "\.\.\/(api|state|commands)\b/);
    expect(source).not.toMatch(/useDaw/);
  });
});
