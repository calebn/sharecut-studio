/** Stable per-tab DAW client id (sessionStorage). */

import { documentClientId } from "../utils/documentClient";

export function newClientId(): string {
  try {
    return documentClientId();
  } catch {
    return `viewer-${crypto.randomUUID().slice(0, 8)}`;
  }
}
