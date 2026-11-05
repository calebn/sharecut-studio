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
        update={{ id: "v2", label: "Intro fix", onListen }}
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
        update={{ id: "v2", label: null, onListen: vi.fn() }}
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
        update={{ id: "v2", label: "Intro fix", onListen }}
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
        update={{ id: "v2", label: "Intro fix", onListen: vi.fn() }}
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
    const update = (label: string, id = label) => ({
      id,
      label,
      onListen: vi.fn(),
    });
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

  it("opens the pill again for a new version with the same label, and restarts the 10 s", () => {
    vi.useFakeTimers();
    const update = (id: string) => ({
      id,
      label: null,
      onListen: vi.fn(),
    });
    const { rerender } = render(
      <VersionLine label="A" followsLatest update={update("v2")} />,
    );
    act(() => {
      vi.advanceTimersByTime(NEW_VERSION_PILL_MS);
    });
    expect(screen.getByRole("button").className).toBe("sys-version-line");
    rerender(<VersionLine label="A" followsLatest update={update("v3")} />);
    expect(screen.getByRole("button").className).toBe("sys-version-pill");
    act(() => {
      vi.advanceTimersByTime(NEW_VERSION_PILL_MS - 1);
    });
    expect(screen.getByRole("button").className).toBe("sys-version-pill");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button").className).toBe("sys-version-line");
  });

  it("announces only the new version, never the label", () => {
    const { rerender } = render(<VersionLine label="A" followsLatest />);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    rerender(<VersionLine label="Z" followsLatest />);
    expect(region.textContent).toBe("");
    rerender(
      <VersionLine
        label="Z"
        followsLatest
        update={{ id: "v2", label: "B", onListen: vi.fn() }}
      />,
    );
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("New version: B. Listen");
  });
});
