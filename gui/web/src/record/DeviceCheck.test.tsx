import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { DeviceCheck } from "./DeviceCheck";
import {
  MIC_ALLOW_LABEL,
  MIC_DENIED_COPY,
  MIC_DESKTOP_DENIED_COPY,
  MIC_ERROR_COPY,
  MIC_GRANT_HINT_COPY,
  MIC_RETRY_LABEL,
  MIC_UNAVAILABLE_COPY,
} from "./micPermission";

const base = {
  headphonesOk: true,
  deviceId: "",
  onDeviceId: () => undefined,
  stream: null,
  devices: [] as MediaDeviceInfo[],
  error: null,
  settingsWarning: null,
  grantHintId: "grant-hint",
  headphonesHintId: "headphones-hint",
};

describe("DeviceCheck", () => {
  it("shows Allow microphone while idle and is axe-clean", async () => {
    const onAllow = vi.fn();
    const { container } = render(
      <DeviceCheck
        {...base}
        permission="idle"
        onAllow={onAllow}
        onRetry={() => undefined}
      />,
    );
    const allow = screen.getByRole("button", { name: MIC_ALLOW_LABEL });
    expect(allow).toHaveAttribute("aria-describedby", "grant-hint");
    await userEvent.click(allow);
    expect(onAllow).toHaveBeenCalled();
    expect(screen.queryByLabelText("Level")).toBeNull();
    expect(screen.getByText(MIC_GRANT_HINT_COPY)).toHaveAttribute(
      "id",
      "grant-hint",
    );
    await expectNoA11yViolations(container);
  });

  it("disables Allow while prompting", async () => {
    const { container } = render(
      <DeviceCheck
        {...base}
        permission="prompting"
        onAllow={() => undefined}
        onRetry={() => undefined}
      />,
    );
    const allow = screen.getByRole("button", { name: MIC_ALLOW_LABEL });
    expect(allow).toBeDisabled();
    expect(allow).toHaveAttribute("aria-describedby", "grant-hint");
    expect(allow).toHaveAttribute("aria-busy", "true");
    await expectNoA11yViolations(container);
  });

  it("shows denied copy and Retry", async () => {
    const onRetry = vi.fn();
    const { container } = render(
      <DeviceCheck
        {...base}
        permission="denied"
        onAllow={() => undefined}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(MIC_DENIED_COPY)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: MIC_RETRY_LABEL });
    expect(retry).toHaveAttribute("aria-describedby", "grant-hint");
    await userEvent.click(retry);
    expect(onRetry).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: MIC_ALLOW_LABEL })).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("shows operating-system guidance for denied Tauri microphone access", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Windows NT 10.0)",
    });

    try {
      const { container } = render(
        <DeviceCheck
          {...base}
          permission="denied"
          onAllow={() => undefined}
          onRetry={() => undefined}
        />,
      );
      expect(screen.getByText(MIC_DESKTOP_DENIED_COPY)).toBeInTheDocument();
      expect(screen.queryByText(MIC_DENIED_COPY)).toBeNull();
      await expectNoA11yViolations(container);
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__;
      Reflect.deleteProperty(navigator, "userAgent");
    }
  });

  it("shows unavailable copy and Retry", async () => {
    const { container } = render(
      <DeviceCheck
        {...base}
        permission="unavailable"
        onAllow={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText(MIC_UNAVAILABLE_COPY)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: MIC_RETRY_LABEL })).toBeEnabled();
    await expectNoA11yViolations(container);
  });

  it("shows raw error and Retry for unmapped failures", async () => {
    const { container } = render(
      <DeviceCheck
        {...base}
        permission="error"
        error="Could not start audio source"
        onAllow={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText(MIC_ERROR_COPY)).toBeInTheDocument();
    expect(
      screen.getByText("Could not start audio source"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: MIC_RETRY_LABEL })).toBeEnabled();
    await expectNoA11yViolations(container);
  });

  it("shows the meter after grant and focuses Input", async () => {
    const { container, rerender } = render(
      <DeviceCheck
        {...base}
        permission="idle"
        onAllow={() => undefined}
        onRetry={() => undefined}
      />,
    );
    rerender(
      <DeviceCheck
        {...base}
        permission="granted"
        onAllow={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByLabelText("Level")).toBeInTheDocument();
    expect(screen.getByLabelText("Input")).toHaveFocus();
    expect(screen.queryByRole("button", { name: MIC_ALLOW_LABEL })).toBeNull();
    await expectNoA11yViolations(container);
  });
});
