import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { DeviceSheet, type DeviceSheetProps } from "./DeviceSheet";
import type { DeviceMic } from "./deviceSheetModel";

const READY = {
  status: "ready",
  input: "USB Mic",
  level: 0.3,
  devices: [
    { id: "a", label: "USB Mic" },
    { id: "b", label: "Headset" },
  ],
  inputId: "a",
} satisfies DeviceMic;

const TONE = { state: "idle", label: "Record 1 minute of room tone" } as const;

const sheet = (props: Partial<DeviceSheetProps> = {}) => (
  <DeviceSheet
    mic={READY}
    tone={TONE}
    onRecordRoomTone={vi.fn()}
    onClose={vi.fn()}
    {...props}
  />
);

describe("DeviceSheet", () => {
  it("is a Devices dialog with no Apply", async () => {
    const { baseElement } = render(sheet());
    expect(screen.getByRole("dialog", { name: "Devices" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply/i })).toBeNull();
    await expectNoA11yViolations(baseElement);
  });

  it("applies an input change at once", async () => {
    const onInputChange = vi.fn();
    render(sheet({ onInputChange }));
    await userEvent.selectOptions(screen.getByLabelText("Input"), "b");
    expect(onInputChange).toHaveBeenCalledWith("b");
  });

  it("locks the input menu while a take is running", () => {
    render(sheet({ mic: { ...READY, inputLocked: true } }));
    expect(screen.getByLabelText("Input")).toBeDisabled();
    expect(
      screen.getByText("Can't change while a take is running."),
    ).toBeVisible();
  });

  it("locks a lost input's menu only while a take is running", () => {
    const lost = {
      status: "lost",
      devices: READY.devices,
      inputId: "a",
    } satisfies DeviceMic;
    const { rerender } = render(sheet({ mic: { ...lost, inputLocked: true } }));
    expect(screen.getByLabelText("Input")).toBeDisabled();
    rerender(sheet({ mic: lost }));
    expect(screen.getByLabelText("Input")).toBeEnabled();
  });

  it("toggles headphones, and omits the toggle without a handler", async () => {
    const onHeadphonesChange = vi.fn();
    const { rerender } = render(sheet({ onHeadphonesChange }));
    await userEvent.click(
      screen.getByRole("button", { name: "I'm wearing headphones" }),
    );
    expect(onHeadphonesChange).toHaveBeenCalledWith(true);
    rerender(sheet());
    expect(screen.queryByText("Headphones")).toBeNull();
  });

  it("records room tone from the row", async () => {
    const onRecordRoomTone = vi.fn();
    render(sheet({ onRecordRoomTone }));
    await userEvent.click(screen.getByRole("button", { name: TONE.label }));
    expect(onRecordRoomTone).toHaveBeenCalledOnce();
  });

  it("counts the take down with End early and Cancel in place of Record", async () => {
    const onEndRoomToneEarly = vi.fn();
    const onCancelRoomTone = vi.fn();
    const { baseElement } = render(
      sheet({
        tone: {
          ...TONE,
          state: "capturing",
          message: "Stay quiet · 0:42",
          progress: 0.3,
        },
        onEndRoomToneEarly,
        onCancelRoomTone,
      }),
    );
    expect(screen.getByText("Stay quiet · 0:42")).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: "Room tone" }),
    ).toHaveAttribute("aria-valuenow", "30");
    expect(screen.queryByRole("button", { name: TONE.label })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "End early" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onEndRoomToneEarly).toHaveBeenCalledOnce();
    expect(onCancelRoomTone).toHaveBeenCalledOnce();
    await expectNoA11yViolations(baseElement);
  });

  it("holds End early once the take is saving", () => {
    render(
      sheet({
        tone: {
          ...TONE,
          state: "capturing",
          message: "Saving room tone…",
          progress: 1,
          endEarlyDisabled: true,
        },
      }),
    );
    expect(screen.getByRole("button", { name: "End early" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("moves focus to Cancel when End early is pressed into saving, and back to Record when the take ends", async () => {
    const capturing = {
      ...TONE,
      state: "capturing",
      message: "Stay quiet · 0:30",
      progress: 0.5,
    } as const;
    const { rerender } = render(sheet());
    const record = screen.getByRole("button", { name: TONE.label });
    record.focus();
    rerender(sheet({ tone: capturing }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    screen.getByRole("button", { name: "End early" }).focus();
    rerender(
      sheet({
        tone: {
          ...capturing,
          message: "Saving room tone…",
          endEarlyDisabled: true,
        },
      }),
    );
    expect(screen.getByRole("button", { name: "End early" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    rerender(sheet());
    expect(screen.getByRole("button", { name: TONE.label })).toHaveFocus();
  });

  it("says why room tone waits", () => {
    render(
      sheet({ tone: { ...TONE, disabledReason: "Record between takes." } }),
    );
    const button = screen.getByRole("button", { name: TONE.label });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    expect(button).toHaveAccessibleDescription("Record between takes.");
    expect(screen.getByText("Record between takes.")).toBeVisible();
    button.focus();
    expect(button).toHaveFocus();
  });

  it("refuses to record room tone while it waits and records once it is ready", async () => {
    const onRecordRoomTone = vi.fn();
    const { rerender } = render(
      sheet({
        tone: { ...TONE, disabledReason: "Record between takes." },
        onRecordRoomTone,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: TONE.label }));
    expect(onRecordRoomTone).not.toHaveBeenCalled();
    rerender(sheet({ onRecordRoomTone }));
    const button = screen.getByRole("button", { name: TONE.label });
    expect(button).not.toHaveAttribute("aria-disabled");
    await userEvent.click(button);
    expect(onRecordRoomTone).toHaveBeenCalledTimes(1);
  });

  it("shows a room tone that was too loud", async () => {
    const { baseElement } = render(
      sheet({
        tone: {
          ...TONE,
          state: "too-loud",
          message: "Too loud: is something playing?",
        },
      }),
    );
    expect(screen.getByText("Too loud: is something playing?")).toBeVisible();
    expect(baseElement.querySelector("[data-state]")).toHaveAttribute(
      "data-state",
      "room-tone-too-loud",
    );
    await expectNoA11yViolations(baseElement);
  });

  it("asks the caller to act when the mic is blocked", async () => {
    const onMicAction = vi.fn();
    const { baseElement } = render(
      sheet({ mic: { status: "denied" }, onMicAction }),
    );
    expect(screen.queryByLabelText("Input")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "How to allow the microphone" }),
    );
    expect(onMicAction).toHaveBeenCalledWith("how-to");
    await expectNoA11yViolations(baseElement);
  });

  it("offers Retry for a lost input and for no input", async () => {
    const onMicAction = vi.fn();
    const { rerender } = render(
      sheet({
        mic: { status: "lost", detail: "Microphone disconnected." },
        onMicAction,
      }),
    );
    expect(screen.getByText("Microphone disconnected.")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry microphone" }),
    );
    rerender(sheet({ mic: { status: "none" }, onMicAction }));
    expect(screen.getByText("No microphone found")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry microphone" }),
    );
    expect(onMicAction).toHaveBeenCalledTimes(2);
    expect(onMicAction).toHaveBeenLastCalledWith("retry");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(sheet({ onClose }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("is a bottom sheet on the phone", () => {
    render(sheet({ viewerWidth: "phone" }));
    expect(screen.getByRole("dialog", { name: "Devices" })).toBeInTheDocument();
    expect(document.querySelector(".sys-sheet-bottom")).not.toBeNull();
    expect(document.querySelector(".sys-sheet-centered")).toBeNull();
  });

  describe("speaker", () => {
    const output = {
      supported: true,
      devices: [
        { id: "hp", label: "Headset" },
        { id: "sp", label: "Desk speakers" },
      ],
      selectedId: "hp",
    };

    it("draws no speaker row without support", () => {
      const { rerender } = render(sheet());
      expect(screen.queryByLabelText("Speaker")).toBeNull();
      rerender(sheet({ output: { ...output, supported: false } }));
      expect(screen.queryByLabelText("Speaker")).toBeNull();
    });

    it("lists the speakers and applies a pick at once", async () => {
      const onOutputChange = vi.fn();
      const { baseElement } = render(sheet({ output, onOutputChange }));
      const menu = screen.getByLabelText("Speaker");
      expect(menu).toHaveValue("hp");
      expect(menu).not.toHaveAttribute("aria-describedby");
      expect(menu).toBeEnabled();
      await userEvent.selectOptions(menu, "sp");
      expect(onOutputChange).toHaveBeenCalledWith("sp");
      await userEvent.selectOptions(menu, "");
      expect(onOutputChange).toHaveBeenLastCalledWith("");
      await expectNoA11yViolations(baseElement);
    });

    it("asks for a fresh speaker list when the sheet opens", () => {
      const onOutputRefresh = vi.fn();
      render(sheet({ output, onOutputRefresh }));
      expect(onOutputRefresh).toHaveBeenCalledOnce();
    });

    it("says when a pick did not stick", async () => {
      const { baseElement } = render(
        sheet({
          output: {
            ...output,
            selectedId: "",
            error: "Couldn't switch speakers. Using the default.",
          },
        }),
      );
      expect(
        screen.getByText("Couldn't switch speakers. Using the default."),
      ).toBeVisible();
      expect(screen.getByLabelText("Speaker")).toHaveValue("");
      expect(screen.getByLabelText("Speaker")).toHaveAccessibleDescription(
        "Couldn't switch speakers. Using the default.",
      );
      expect(
        screen.getByText("Couldn't switch speakers. Using the default."),
      ).toHaveAttribute("role", "status");
      await expectNoA11yViolations(baseElement);
    });
  });
});
