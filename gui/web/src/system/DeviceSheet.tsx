import { useState } from "react";
import { Button, ToggleButton } from "../ui";
import type { DrawerDetent } from "../ui/BottomSheet";
import {
  type DeviceMic,
  type DeviceTone,
  deviceSheetModel,
} from "./deviceSheetModel";
import { JOIN_TEXT, type JoinMicAction } from "./joinSheetModel";
import { MicRow } from "./MicRow";
import { Sheet } from "./Sheet";
import { StatusRow } from "./StatusRow";
import { SystemIcon } from "./SystemIcon";

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
  onClose: () => void;
};

/**
 * Change the microphone from inside the room: input menu, level meter with a
 * clip tick, the headphone toggle and a 3 s room tone for someone who joined
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
  onClose,
}: DeviceSheetProps) {
  const [detent, setDetent] = useState<DrawerDetent>("full");
  const model = deviceSheetModel({ mic, micNotes, headphones, tone });
  const { action } = model.mic;
  return (
    <Sheet
      form={viewerWidth === "phone" ? "bottom" : "centered"}
      title="Devices"
      panelClassName="sys-join-sheet"
      detent={detent}
      onDetentChange={setDetent}
      onClose={onClose}
    >
      <div className="sys-join" data-state={model.state}>
        <div className="sys-join-row">
          <StatusRow
            state={model.mic.state}
            title={model.mic.title}
            detail={model.mic.detail}
            action={
              action
                ? {
                    label: action.label,
                    name: action.name,
                    onAction: () => {
                      if (action.kind !== "blocker") onMicAction?.(action.kind);
                    },
                  }
                : undefined
            }
          />
          <div className="sys-join-control">
            <MicRow
              mic={model.control}
              notes={model.micNotes}
              onInputChange={onInputChange}
            />
          </div>
        </div>
        {onHeadphonesChange ? (
          <div className="sys-join-row">
            <StatusRow
              state={model.headphones.state}
              title={model.headphones.title}
            />
            <div className="sys-join-control">
              <ToggleButton
                pressed={headphones}
                onClick={() => onHeadphonesChange(!headphones)}
              >
                <SystemIcon name="headphones" size={16} />
                {JOIN_TEXT.headphones}
              </ToggleButton>
            </div>
          </div>
        ) : null}
        <div className="sys-join-row">
          <StatusRow
            state={model.toneRow.state}
            title={model.toneRow.title}
            detail={model.toneRow.detail}
          />
          <div className="sys-join-control">
            <Button
              disabledReason={tone.disabledReason}
              onClick={onRecordRoomTone}
            >
              {tone.label}
            </Button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
