// The editor's only door into record/: its store, wire, transport chip and helpers.

export { recordingClockMs } from "./clock";
export { landGate } from "./hostControls";
export { useRecordHostStore } from "./hostStore";
export { submitHostRecordTransport } from "./hostTransport";
export { bindRecordHostSend, sendRecordHostCommand } from "./hostWire";
export {
  HOST_COMMENT_QUEUE_TOKEN,
  liveTakeOpen,
  MARKER_BODY,
  postLiveComment,
} from "./liveCommentQueue";
export { emitRecordSignal, isRecordSignal } from "./monitor/signalBus";
export { RecIndicator } from "./RecIndicator";
export { RecordTransportChip } from "./RecordTransportChip";
export {
  activeGuestLink,
  copyText,
  createRecordRoomAndCopyGuestLink,
} from "./recordLinks";
export { SAVE_STATE_COPY } from "./saveStatus";
export type { RecordSnapshot } from "./types";
export { isRecordTransportVisible } from "./types";
