import {
  headphonesRow,
  type JoinMic,
  type JoinNote,
  type JoinRow,
  micNoteList,
  micRow,
} from "./joinSheetModel";
import type { StatusRowState } from "./StatusRow";

/** The Join sheet's mic states plus the one a device list can add: no input at all. */
export type DeviceMic = JoinMic | { status: "none" };

/** The room tone row, in the caller's words: the record side owns the copy. */
export type DeviceTone = {
  state: "idle" | "capturing" | "too-loud" | "recorded" | "error";
  /** The button's label: "Record 3 seconds of room tone". */
  label: string;
  /** The line under the title: where the bed went, or why it failed. */
  message?: string;
  /** Why the button cannot be pressed now. */
  disabledReason?: string;
};

export type DeviceSheetState =
  | "ready"
  | "denied"
  | "input-lost"
  | "no-input"
  | "room-tone-too-loud";

export const DEVICE_TEXT = {
  title: "Devices",
  tone: "Room tone",
  noInput: "No microphone found",
  noInputDetail: "Connect an input device, then Retry.",
} as const;

const TONE_ROW: Record<DeviceTone["state"], StatusRowState> = {
  idle: "queued",
  capturing: "running",
  "too-loud": "needs-you",
  recorded: "done",
  error: "failed",
};

type ToneRow = { state: StatusRowState; title: string; detail?: string };

const NO_MIC: JoinMic = { status: "idle" };

export type DeviceSheetModel = {
  state: DeviceSheetState;
  mic: JoinRow;
  /** What the meter and the input menu draw; nothing for a missing input. */
  control: JoinMic;
  micNotes: JoinNote[];
  headphones: JoinRow;
  tone: DeviceTone;
  toneRow: ToneRow;
};

function deviceMicRow(mic: DeviceMic): JoinRow {
  if (mic.status !== "none") return micRow(mic);
  return {
    key: "mic",
    state: "failed",
    title: DEVICE_TEXT.noInput,
    detail: DEVICE_TEXT.noInputDetail,
    action: { label: "Retry", name: "Retry microphone", kind: "retry" },
  };
}

function stateOf(mic: DeviceMic, tone: DeviceTone): DeviceSheetState {
  switch (mic.status) {
    case "denied":
      return "denied";
    case "lost":
      return "input-lost";
    case "none":
      return "no-input";
    case "ready":
      return tone.state === "too-loud" ? "room-tone-too-loud" : "ready";
    default:
      return "ready";
  }
}

export function deviceSheetModel(input: {
  mic: DeviceMic;
  micNotes?: string[];
  headphones: boolean;
  tone: DeviceTone;
}): DeviceSheetModel {
  const { mic, tone } = input;
  const control = mic.status === "none" ? NO_MIC : mic;
  return {
    state: stateOf(mic, tone),
    mic: deviceMicRow(mic),
    control,
    micNotes: micNoteList(control, input.micNotes),
    headphones: headphonesRow(input.headphones),
    tone,
    toneRow: {
      state: TONE_ROW[tone.state],
      title: DEVICE_TEXT.tone,
      detail: tone.message,
    },
  };
}
