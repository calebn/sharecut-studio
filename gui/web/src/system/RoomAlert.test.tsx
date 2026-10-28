import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SRC_ROOT } from "../test/sourceFiles";
import { RoomAlert } from "./RoomAlert";
import { ROOM_ALERT_PRIORITY, type RoomAlertInput } from "./roomAlertModel";

const live = () => screen.getByRole("status");

describe("RoomAlert", () => {
  it("keeps an empty live region with no alert", () => {
    render(<RoomAlert alerts={[]} />);
    expect(live()).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the top alert alone, with its one action", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<RoomAlert alerts={[{ kind: "mic-lost", onAction }]} />);
    expect(within(live()).getByText("Your mic stopped.")).toBeVisible();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /more alert/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reconnect mic" }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("offers a second action beside the first when both handlers exist", async () => {
    const onAction = vi.fn();
    const onSecondaryAction = vi.fn();
    const user = userEvent.setup();
    render(
      <RoomAlert
        alerts={[{ kind: "saving-failed", onAction, onSecondaryAction }]}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Save a copy" }));
    expect(onSecondaryAction).toHaveBeenCalledOnce();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("drops the second action without its handler or on a kind without one", () => {
    const { rerender } = render(
      <RoomAlert alerts={[{ kind: "saving-failed", onAction: vi.fn() }]} />,
    );
    expect(screen.queryByRole("button", { name: "Save a copy" })).toBeNull();
    rerender(
      <RoomAlert
        alerts={[
          { kind: "mic-lost", onAction: vi.fn(), onSecondaryAction: vi.fn() },
        ]}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("offers no action when the handler is missing", () => {
    render(<RoomAlert alerts={[{ kind: "no-audio" }]} />);
    expect(
      screen.getByText("No sound is reaching the recorder."),
    ).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("puts every kind in the same polite region, never role alert", () => {
    for (const kind of ROOM_ALERT_PRIORITY) {
      const { unmount } = render(<RoomAlert alerts={[{ kind }]} />);
      const region = live();
      expect(region).not.toBeEmptyDOMElement();
      expect(region.querySelector(".sys-status")).not.toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      unmount();
    }
  });

  it("does not remount the live region when the top kind changes", () => {
    const { rerender } = render(<RoomAlert alerts={[{ kind: "clipping" }]} />);
    const before = live();
    rerender(
      <RoomAlert alerts={[{ kind: "clipping" }, { kind: "mic-lost" }]} />,
    );
    expect(live()).toBe(before);
    expect(within(live()).getByText("Your mic stopped.")).toBeVisible();
  });

  it("keeps the chip and the list outside the live region", async () => {
    const user = userEvent.setup();
    render(<RoomAlert alerts={[{ kind: "muted" }, { kind: "clipping" }]} />);
    const chip = screen.getByRole("button", { name: "1 more alert" });
    expect(live()).not.toContainElement(chip);
    await user.click(chip);
    expect(live()).not.toContainElement(
      screen.getByRole("list", { name: "More alerts" }),
    );
  });

  it("shows +N for the rest and opens them in priority order", async () => {
    const user = userEvent.setup();
    const alerts: RoomAlertInput[] = [
      { kind: "generic", message: "The room closed." },
      { kind: "clipping" },
      { kind: "no-audio" },
    ];
    render(<RoomAlert alerts={alerts} />);
    expect(
      within(live()).getByText("No sound is reaching the recorder."),
    ).toBeVisible();
    const chip = screen.getByRole("button", { name: "2 more alerts" });
    expect(chip).toHaveTextContent("+2");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "More alerts" })).toBeNull();
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("list", { name: "More alerts" });
    expect(
      document.getElementById(chip.getAttribute("aria-controls") ?? ""),
    ).toContainElement(list);
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("You're clipping. Move back a little.");
    expect(items[1]).toHaveTextContent("The room closed.");
    await user.click(chip);
    expect(screen.queryByRole("list", { name: "More alerts" })).toBeNull();
  });

  it("uses the singular for one alert behind the chip", () => {
    render(<RoomAlert alerts={[{ kind: "muted" }, { kind: "clipping" }]} />);
    expect(
      screen.getByRole("button", { name: "1 more alert" }),
    ).toHaveTextContent("+1");
  });

  it("closes the list when nothing is left behind the chip", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RoomAlert alerts={[{ kind: "muted" }, { kind: "clipping" }]} />,
    );
    await user.click(screen.getByRole("button", { name: "1 more alert" }));
    expect(screen.getByRole("list", { name: "More alerts" })).toBeVisible();
    rerender(<RoomAlert alerts={[{ kind: "muted" }]} />);
    expect(screen.queryByRole("button", { name: /more alert/ })).toBeNull();
    rerender(
      <RoomAlert alerts={[{ kind: "muted" }, { kind: "connecting" }]} />,
    );
    expect(screen.queryByRole("list", { name: "More alerts" })).toBeNull();
  });

  it("names the host, falling back to The host", () => {
    const { rerender } = render(
      <RoomAlert alerts={[{ kind: "host-offline", name: "Rosa" }]} />,
    );
    expect(
      screen.getByText("Rosa dropped. You're still recording on this device."),
    ).toBeVisible();
    rerender(<RoomAlert alerts={[{ kind: "host-offline" }]} />);
    expect(
      screen.getByText(
        "The host dropped. You're still recording on this device.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("moves focus to the chip when the top action leaves and others remain", async () => {
    const user = userEvent.setup();
    const alerts: RoomAlertInput[] = [
      { kind: "mic-lost", onAction: vi.fn() },
      { kind: "muted" },
      { kind: "clipping" },
    ];
    const { rerender } = render(<RoomAlert alerts={alerts} />);
    await user.click(screen.getByRole("button", { name: "Reconnect mic" }));
    rerender(<RoomAlert alerts={alerts.slice(1)} />);
    expect(screen.getByRole("button", { name: "1 more alert" })).toHaveFocus();
  });

  it("moves focus to the empty region when the last action leaves", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RoomAlert alerts={[{ kind: "mic-lost", onAction: vi.fn() }]} />,
    );
    await user.click(screen.getByRole("button", { name: "Reconnect mic" }));
    rerender(<RoomAlert alerts={[]} />);
    expect(live()).toHaveFocus();
  });

  it("scales the glyph to 20 px inside the slot's stylesheet", () => {
    const css = readFileSync(
      join(SRC_ROOT, "styles/partials/system-record.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.sys-room-alert-slot \.sys-status--alert \.sys-glyph > svg \{\s*inline-size: 1\.25rem;\s*block-size: 1\.25rem;\s*\}/,
    );
    const { container } = render(<RoomAlert alerts={[{ kind: "muted" }]} />);
    expect(
      container.querySelector(".sys-status--alert .sys-glyph svg"),
    ).not.toBeNull();
  });
});
