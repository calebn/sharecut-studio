import { useDawStore } from "../state/dawStore";
import type { ChromeFlags } from "../state/types";

export function setChrome(patch: Partial<ChromeFlags>): void {
  useDawStore.setState((s) => ({ chrome: { ...s.chrome, ...patch } }));
}
