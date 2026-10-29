// The editor's only door into record/: its store, wire, host room and helpers.

export { recordingClockMs } from "./clock";
export {
  deviceMic,
  deviceTone,
  hostMicStatus,
  useSheetMic,
} from "./deviceSheet";
export {
  type LandGate,
  landGate,
  STOP_CONFIRM_COPY,
  type StartBlockerItem,
} from "./hostControls";
export { useHostRoomContext, useHostRoomSelector } from "./hostRoomContext";
export { hostRoomPhase } from "./hostRoomPhase";
export { useRecordHostStore } from "./hostStore";
export { submitHostRecordTransport } from "./hostTransport";
export { bindRecordHostSend, sendRecordHostCommand } from "./hostWire";
export {
  HOST_COMMENT_QUEUE_TOKEN,
  liveTakeOpen,
  MARKER_BODY,
  postLiveComment,
} from "./liveCommentQueue";
export {
  copyForMicStatus,
  MIC_RETRY_LABEL,
  MIC_SAVED_DEVICE_MISSING_COPY,
} from "./micPermission";
export { emitRecordSignal, isRecordSignal } from "./monitor/signalBus";
export { noteItems } from "./noteItems";
export {
  activeGuestLink,
  copyText,
  createRecordRoomAndCopyGuestLink,
} from "./recordLinks";
export { roomAlerts } from "./roomAlerts";
export { roomPeople } from "./roomPeople";
export { type RoomToneDelivery, type RoomToneStatus } from "./roomTone";
export { StorageHeadroomWarning } from "./StorageHeadroomWarning";
export { SAVE_STATE_COPY, type SegmentAckRow } from "./saveStatus";
export { type TakeInput, takeInputs } from "./takeInputs";
export {
  type CaptureHealth,
  HEARING_COPY,
  isRecordTransportVisible,
  LOCAL_KEEPER_COPY,
  RECORD_ROOM_RECONNECTING_COPY,
  type RecordSnapshot,
  ROOM_TONE_CAPTURING_COPY,
  ROOM_TONE_DEVICE_COPY,
  ROOM_TONE_HOST_COPY,
  ROOM_TONE_NOT_READY_COPY,
  ROOM_TONE_PROMPT_COPY,
  ROOM_TONE_TOO_LOUD_COPY,
} from "./types";
export { UploadStatus } from "./UploadStatus";
export { type HostRoom, useHostRoom } from "./useHostRoom";
export { useInputPeakDb } from "./useInputPeakDb";
