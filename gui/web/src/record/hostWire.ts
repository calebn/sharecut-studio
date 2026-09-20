const SEQ_KEY = "daw_record_client_seq";

let sender:
  | ((
      commandType: string,
      payload: Record<string, unknown>,
      commandId?: string,
    ) => void)
  | null = null;

export function nextHostRecordClientSeq(): number {
  try {
    const raw = sessionStorage.getItem(SEQ_KEY);
    const parsed = Number.parseInt(raw || "0", 10);
    const next = (Number.isFinite(parsed) && parsed > 0 ? parsed : 0) + 1;
    sessionStorage.setItem(SEQ_KEY, String(next));
    return next;
  } catch {
    return Date.now();
  }
}

export function bindRecordHostSend(
  send: ((frame: Record<string, unknown>) => void) | null,
): void {
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
        send(frame);
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
  sender(commandType, payload, commandId);
  return true;
}
