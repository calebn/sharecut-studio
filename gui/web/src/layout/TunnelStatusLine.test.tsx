import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import type { TunnelState, TunnelStatus } from "../types/tunnel";
import { TunnelStatusLine } from "./TunnelStatusLine";

const NOW_MS = 1_000_000;

function status(
  state: TunnelState,
  overrides: Partial<TunnelStatus> = {},
): TunnelStatus {
  return {
    state,
    reason: null,
    reason_kind: null,
    relay_host: "relay.example.test",
    public_base_url: "https://share.example.test",
    share_count: 2,
    retry_at: null,
    ...overrides,
  };
}

function mockReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query.includes("reduce"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe("TunnelStatusLine", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
    vi.setSystemTime(NOW_MS);
    mockReducedMotion(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("counts down to the next reconnect try outside the live region", () => {
    render(
      <TunnelStatusLine
        status={status("reconnecting", { retry_at: NOW_MS / 1000 + 5 })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reconnecting… guests may see a brief interruption",
    );
    expect(screen.getByText("Trying again in 5 s")).toBeInTheDocument();
    expect(screen.getByRole("status")).not.toHaveTextContent("Trying");

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("Trying again in 2 s")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("Trying again now")).toBeInTheDocument();
  });

  it("shows a still clock time instead of a ticking countdown under reduced motion", () => {
    mockReducedMotion(true);
    render(
      <TunnelStatusLine
        status={status("reconnecting", { retry_at: NOW_MS / 1000 + 5 })}
      />,
    );
    const before = screen.getByText(/^Next try at /).textContent;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText(/^Next try at /).textContent).toBe(before);
    expect(screen.queryByText(/Trying again in/)).not.toBeInTheDocument();
  });

  it("keeps the fix behind a How to fix disclosure with a guide link; axe-clean", async () => {
    vi.useRealTimers();
    const { container } = render(
      <TunnelStatusLine status={status("offline", { reason_kind: "auth" })} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Not reachable online: guests can't open links until you're back online",
    );
    const fix = screen.getByText(/refused this computer's access key/);
    expect(fix).not.toBeVisible();
    await userEvent.click(screen.getByText("How to fix"));
    expect(fix).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: "Online sharing guide (opens in a new tab)",
      }),
    ).toHaveAttribute(
      "href",
      "https://github.com/calebn/sharecut-studio/blob/main/docs/host-online-relay.md#tunnel-status",
    );
    await expectNoA11yViolations(container);
  });

  it("is neutral when online sharing is off and absent for a local-only host", () => {
    const { rerender } = render(<TunnelStatusLine status={status("off")} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Online sharing is off",
    );
    expect(screen.getByText("How to turn it on")).toBeInTheDocument();

    rerender(<TunnelStatusLine status={status("not_set_up")} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows no countdown when online", () => {
    render(<TunnelStatusLine status={status("online")} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Guests can open your links",
    );
    expect(screen.queryByText(/Trying again|Next try/)).not.toBeInTheDocument();
    expect(screen.queryByText("How to fix")).not.toBeInTheDocument();
  });
});
