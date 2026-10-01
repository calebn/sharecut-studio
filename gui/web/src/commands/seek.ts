import { executePointerCommand } from "./pointer";
import type { ExecuteResult } from "./types";

export function seekTransport(sec: number): Promise<ExecuteResult> {
  return executePointerCommand("transport.seek", { sec });
}
