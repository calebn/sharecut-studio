import { useEffect, useRef, useState } from "react";
import { Button } from "../ui";
import type { DrawerDetent } from "../ui/BottomSheet";
import {
  DEVICE_TEXT,
  type DeviceMic,
  type DeviceOutput,
  type DeviceTone,
  deviceSheetModel,
} from "./deviceSheetModel";
import { HeadphonesToggle } from "./HeadphonesToggle";
import type { JoinMicAction } from "./joinSheetModel";
import { MicRow } from "./MicRow";
import { OutputRow } from "./OutputRow";
import { Sheet } from "./Sheet";
import { SheetRow } from "./SheetRow";
import { useFocusOffDisabled } from "./useFocusOffDisabled";
import { useFocusRescue } from "./useFocusRescue";

export type DeviceSheetProps = {
  /** `phone` is the bottom sheet; `desktop` a centred card. */
  viewerWidth?: "desktop" | "phone";
  mic: DeviceMic;
  /** Extra lines under the mic meter, such as "your saved microphone is gone". */
  micNotes?: string[];
  onMicAction?: (action: JoinMicAction) => void;
  /** The input picked in the mic row; `mic.devices` fills the list. */
  onInputChange?: (inputId: string) => void;
  headphones?: boolean;
  /** Absent for a seat that has no headphone check, and the toggle is not drawn. */
  onHeadphonesChange?: (on: boolean) => void;
  /** Absent, or `supported` false, and the speaker row is not drawn. */
  output?: DeviceOutput;
  onOutputChange?: (outputId: string) => void;
  /** Called when the sheet opens: speaker names may have become readable since. */
  onOutputRefresh?: () => void;
  tone: DeviceTone;
  onRecordRoomTone: () => void;
  /** While the take runs: keep what was captured so far. */
  onEndRoomToneEarly?: () => void;
  /** While the take runs: drop it and go back to idle. */
  onCancelRoomTone?: () => void;
  onClose: () => void;
};

/**
 * Change the microphone from inside the room: input menu, level meter with a
 * clip tick, the headphone toggle, a speaker menu where the browser can route
 * audio, and a one-minute room tone for someone who joined after the countdown. Every control applies as it changes; there is no Apply.
 * Presentational: the caller owns the mic, the meter and the room tone.
 */
export function DeviceSheet({
  viewerWidth = "desktop",
  mic,
  micNotes,
  onMicAction,
  onInputChange,
  headphones = false,
  onHeadphonesChange,
  output,
  onOutputChange,
  onOutputRefresh,
  tone,
  onRecordRoomTone,
  onEndRoomToneEarly,
  onCancelRoomTone,
  onClose,
}: DeviceSheetProps) {
  const [detent, setDetent] = useState<DrawerDetent>("full");
  const model = deviceSheetModel({
    mic,
    micNotes,
    headphones,
    tone,
    output,
  });
  const toneControls = useRef<HTMLDivElement>(null);
  // Record gives way to End early and Cancel, and back: focus follows to the
  // button that replaces the one pressed (Cancel while a take runs, else Record).
  useFocusRescue(toneControls, (target) => {
    const starting = !target.closest(".sys-device-tone-actions");
    return () =>
      starting
        ? toneControls.current?.querySelector<HTMLElement>(
            ".sys-device-tone-actions button:last-child",
          )
        : toneControls.current?.querySelector<HTMLElement>("button");
  });
  useEffect(() => {
    onOutputRefresh?.();
  }, [onOutputRefresh]);
  useFocusOffDisabled(toneControls, tone.endEarlyDisabled === true);
  return (
    <Sheet
      form={viewerWidth === "phone" ? "bottom" : "centered"}
      title={DEVICE_TEXT.title}
      panelClassName="sys-join-sheet"
      detent={detent}
      onDetentChange={setDetent}
      onClose={onClose}
    >
      <div className="sys-join" data-state={model.state}>
        <SheetRow
          row={model.mic}
          onAction={(kind) => {
            if (kind !== "blocker") onMicAction?.(kind);
          }}
        >
          <MicRow
            mic={model.control}
            notes={model.micNotes}
            onInputChange={onInputChange}
          />
        </SheetRow>
        {onHeadphonesChange ? (
          <SheetRow row={model.headphones}>
            <HeadphonesToggle
              pressed={headphones}
              onChange={onHeadphonesChange}
            />
          </SheetRow>
        ) : null}
        {model.output ? (
          <SheetRow row={model.output.row}>
            <OutputRow output={model.output} onOutputChange={onOutputChange} />
          </SheetRow>
        ) : null}
        <SheetRow row={model.toneRow}>
          <div ref={toneControls} className="sys-device-tone">
            {tone.state === "capturing" ? (
              <div className="sys-device-tone-actions">
                <Button
                  disabledReason={
                    tone.endEarlyDisabled ? "Room tone is saving." : undefined
                  }
                  onClick={onEndRoomToneEarly}
                >
                  End early
                </Button>
                <Button onClick={onCancelRoomTone}>Cancel</Button>
              </div>
            ) : (
              <Button
                disabledReason={tone.disabledReason}
                onClick={onRecordRoomTone}
              >
                {tone.label}
              </Button>
            )}
          </div>
        </SheetRow>
      </div>
    </Sheet>
  );
}
