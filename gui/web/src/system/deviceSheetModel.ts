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
  state: "idle" | "capturing" | "too-loud" | "too-short" | "recorded" | "error";
  /** The button's label: "Record 1 minute of room tone". */
  label: string;
  /** The line under the title: where the bed went, or why it failed. */
  message?: string;
  /** While capturing, 0 to 1 of the take used; drawn as the row's bar. */
  progress?: number;
  /** While capturing, the take is already saving and End early has nothing left to end. */
  endEarlyDisabled?: boolean;
  /** Why the button cannot be pressed now. */
  disabledReason?: string;
};

/** The speaker menu: only drawn when the browser can route the room's audio. */
export type DeviceOutput = {
  /** False when the browser cannot pick a speaker; the row is then absent. */
  supported: boolean;
  devices: { id: string; label: string }[];
  /** "" is the system default. */
  selectedId: string;
  /** Why the pick did not stick: the device would not open or is gone. */
  error?: string;
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
  speaker: "Speaker",
  defaultOutput: "Default",
  outputFailed: "Couldn't switch speakers. Using the default.",
  outputGone: "Your saved speaker is gone. Using the default.",
} as const;

const TONE_ROW: Record<DeviceTone["state"], StatusRowState> = {
  idle: "queued",
  capturing: "running",
  "too-loud": "needs-you",
  "too-short": "needs-you",
  recorded: "done",
  error: "failed",
};

type ToneRow = {
  state: StatusRowState;
  title: string;
  detail?: string;
  progress?: number;
};

const NO_MIC: JoinMic = { status: "idle" };

export type DeviceSheetModel = {
  state: DeviceSheetState;
  mic: JoinRow;
  /** What the meter and the input menu draw; nothing for a missing input. */
  control: JoinMic;
  micNotes: JoinNote[];
  headphones: JoinRow;
  /** Null when the browser cannot pick a speaker: there is no row at all. */
  output: {
    row: Omit<JoinRow, "key">;
    devices: { id: string; label: string }[];
    selectedId: string;
    notes: JoinNote[];
  } | null;
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

function outputOf(output?: DeviceOutput): DeviceSheetModel["output"] {
  if (!output?.supported) return null;
  const label = output.devices.find(
    (device) => device.id === output.selectedId,
  )?.label;
  return {
    row: {
      state: output.error ? "needs-you" : "done",
      title: DEVICE_TEXT.speaker,
      detail: output.selectedId ? label : DEVICE_TEXT.defaultOutput,
    },
    devices: output.devices,
    selectedId: output.selectedId,
    notes: output.error ? [{ tone: "warning", text: output.error }] : [],
  };
}

export function deviceSheetModel(input: {
  mic: DeviceMic;
  micNotes?: string[];
  headphones: boolean;
  tone: DeviceTone;
  output?: DeviceOutput;
}): DeviceSheetModel {
  const { mic, tone } = input;
  const control = mic.status === "none" ? NO_MIC : mic;
  return {
    state: stateOf(mic, tone),
    mic: deviceMicRow(mic),
    control,
    micNotes: micNoteList(control, input.micNotes),
    headphones: headphonesRow(input.headphones),
    output: outputOf(input.output),
    toneRow: {
      state: TONE_ROW[tone.state],
      title: DEVICE_TEXT.tone,
      detail: tone.message,
      progress: tone.state === "capturing" ? tone.progress : undefined,
    },
  };
}
