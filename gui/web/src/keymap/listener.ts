import { useEffect } from "react";
import { COMMANDS } from "../commands/catalog";
import { buildCommandContext, evaluateWhen } from "../commands/context";
import { execute } from "../commands/execute";
import { keymapHandoff, overlayOpen } from "../ui/modalGate";
import {
  argsFromKeyEvent,
  ignoresKeyRepeat,
  matchKeymapCommands,
} from "./registry";
import { isButtonActivation, isTypingTarget } from "./typing";

/**
 * Sole window-level ShareCut Studio shortcut listener (governance choke-point).
 * Component-local Escape (e.g. BottomSheet) may use separate listeners —
 * see commands/governance.test.ts allowlist. One gate decides what runs while
 * an overlay is open (`keymapHandoff` in `ui/modalGate`): an open menu holds
 * every key; an open modal dialog holds every app shortcut but the ones it
 * hands on (M for a marker on the Record stage), so nothing runs behind an
 * in-app confirm. Native keys inside the dialog (typing in its field, Tab,
 * Enter on its buttons) are left to the browser.
 *
 * When several keymap rows share a key (Backspace Tighten hit, track or clip;
 * Escape follow, comment mode or selection), try each match in the order
 * `SHARED_KEY_ORDER` declares and run the first whose when-clause passes.
 */
export function useDawKeymapListener(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && overlayOpen()) {
        return;
      }
      const handedOn = keymapHandoff();
      if (handedOn?.length === 0) {
        return;
      }
      if (isTypingTarget(e.target) || isButtonActivation(e)) {
        return;
      }
      const matches = matchKeymapCommands(e).filter(
        (cmd) => handedOn == null || handedOn.includes(cmd.id),
      );
      if (!matches.length) {
        return;
      }
      const ctx = buildCommandContext();
      void (async () => {
        for (const cmd of matches) {
          const def = COMMANDS[cmd.id];
          if (!def) {
            continue;
          }
          const gate = evaluateWhen(def.when, ctx);
          if (!gate.ok) {
            continue;
          }
          e.preventDefault();
          if (ignoresKeyRepeat(e, cmd)) {
            return;
          }
          const result = await execute(cmd.id, argsFromKeyEvent(e, cmd.id), {
            ctx,
            skipWhen: true,
          });
          if (result.status === "disabled" && cmd.id.startsWith("tighten.")) {
            continue;
          }
          return;
        }
      })();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
