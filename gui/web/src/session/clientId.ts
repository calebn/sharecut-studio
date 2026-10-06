/** Stable per-tab DAW client id (sessionStorage). */

import { documentClientId } from "../utils/documentClient";
import { randomUuid } from "../utils/randomUuid";

export function newClientId(): string {
  try {
    return documentClientId();
  } catch {
    return `viewer-${randomUuid().slice(0, 8)}`;
  }
}
