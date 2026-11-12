import { nextSeq } from "../utils/monotonicSeq";

const SEQ_KEY = "daw_record_client_seq";

type HostFrameSender = (frame: Record<string, unknown>) => unknown;
type HostCommandSender = (
  commandType: string,
  payload: Record<string, unknown>,
  commandId?: string,
) => boolean;

let sender: HostCommandSender | null = null;

export function nextHostRecordClientSeq(): number {
  return nextSeq(SEQ_KEY);
}

export function bindRecordHostSend(send: HostFrameSender | null): void {
  sender = send
    ? (commandType, payload, commandId) => {
        const frame: Record<string, unknown> = {
          type: "Record",
          command_type: commandType,
          payload,
          client_seq: nextHostRecordClientSeq(),
        };
        if (commandId) {
          frame.command_id = commandId;
        }
        return send(frame) !== false;
      }
    : null;
}

export function sendRecordHostCommand(
  commandType: string,
  payload: Record<string, unknown> = {},
  commandId?: string,
): boolean {
  if (!sender) {
    return false;
  }
  return sender(commandType, payload, commandId);
}
