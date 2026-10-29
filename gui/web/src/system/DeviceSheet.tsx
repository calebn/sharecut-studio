import { useState } from "react";
import { Button } from "../ui";
import type { DrawerDetent } from "../ui/BottomSheet";
import {
  DEVICE_TEXT,
  type DeviceMic,
  type DeviceTone,
  deviceSheetModel,
} from "./deviceSheetModel";
import { HeadphonesToggle } from "./HeadphonesToggle";
import type { JoinMicAction } from "./joinSheetModel";
import { MicRow } from "./MicRow";
import { Sheet } from "./Sheet";
import { SheetRow } from "./SheetRow";

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
 * clip tick, the headphone toggle and a one-minute room tone for someone who joined
 * after the countdown. Every control applies as it changes; there is no Apply.
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
  tone,
  onRecordRoomTone,
  onEndRoomToneEarly,
  onCancelRoomTone,
  onClose,
}: DeviceSheetProps) {
  const [detent, setDetent] = useState<DrawerDetent>("full");
  const model = deviceSheetModel({ mic, micNotes, headphones, tone });
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
        <SheetRow row={model.toneRow}>
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
        </SheetRow>
      </div>
    </Sheet>
  );
}
