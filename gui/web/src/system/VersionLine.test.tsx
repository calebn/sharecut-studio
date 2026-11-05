import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NEW_VERSION_PILL_MS, VersionLine } from "./VersionLine";

describe("VersionLine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a pin for a frozen link and nothing else", () => {
    render(<VersionLine label="Rough cut" followsLatest={false} />);
    expect(screen.getByText("Rough cut")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Pinned to this version" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the live glyph for a following link", () => {
    render(<VersionLine label="Rough cut" followsLatest />);
    expect(
      screen.getByRole("img", { name: "Follows the latest version" }),
    ).toBeTruthy();
  });

  it("shows no glyph until the version is known", () => {
    render(<VersionLine label="Shared link" />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("offers Listen in an accent pill that runs onListen", async () => {
    const onListen = vi.fn();
    render(
      <VersionLine
        label="Rough cut"
        followsLatest
        update={{ label: "Intro fix", onListen }}
      />,
    );
    const pill = screen.getByRole("button", { name: /New version: Intro fix/ });
    expect(pill.textContent).toContain("Listen");
    await userEvent.click(pill);
    expect(onListen).toHaveBeenCalledOnce();
  });

  it("names an unnamed new version without a label", () => {
    render(
      <VersionLine
        label="Rough cut"
        followsLatest
        update={{ label: null, onListen: vi.fn() }}
      />,
    );
    expect(screen.getByRole("button").textContent).toBe("New version·Listen");
  });

  it("folds into the version line with a dot after 10 s, still able to Listen", async () => {
    vi.useFakeTimers();
    const onListen = vi.fn();
    const { container } = render(
      <VersionLine
        label="Rough cut"
        followsLatest
        update={{ label: "Intro fix", onListen }}
      />,
    );
    expect(container.querySelector(".sys-version-dot")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(NEW_VERSION_PILL_MS);
    });
    expect(container.querySelector(".sys-version-dot")).not.toBeNull();
    const line = screen.getByRole("button", {
      name: "Rough cut. New version: Intro fix. Listen",
    });
    act(() => {
      line.click();
    });
    expect(onListen).toHaveBeenCalledOnce();
  });

  it("keeps focus on the same button when the pill folds", () => {
    vi.useFakeTimers();
    render(
      <VersionLine
        label="Rough cut"
        followsLatest
        update={{ label: "Intro fix", onListen: vi.fn() }}
      />,
    );
    const button = screen.getByRole("button");
    button.focus();
    act(() => {
      vi.advanceTimersByTime(NEW_VERSION_PILL_MS);
    });
    expect(screen.getByRole("button")).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("opens the pill again for a different new version", () => {
    vi.useFakeTimers();
    const update = (label: string) => ({ label, onListen: vi.fn() });
    const { rerender } = render(
      <VersionLine label="A" followsLatest update={update("B")} />,
    );
    act(() => {
      vi.advanceTimersByTime(NEW_VERSION_PILL_MS);
    });
    expect(screen.queryByText("New version: B")).toBeNull();
    rerender(<VersionLine label="A" followsLatest update={update("C")} />);
    expect(screen.getByText("New version: C")).toBeInTheDocument();
  });

  it("announces the pill through a status region that is always present", () => {
    const { rerender } = render(<VersionLine label="A" followsLatest />);
    const region = screen.getByRole("status");
    rerender(
      <VersionLine
        label="A"
        followsLatest
        update={{ label: "B", onListen: vi.fn() }}
      />,
    );
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toContain("New version: B");
  });
});
