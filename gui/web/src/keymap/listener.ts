import { useEffect } from "react";
import { COMMANDS } from "../commands/catalog";
import { buildCommandContext, evaluateWhen } from "../commands/context";
import { execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";
import { peekMenuOpen } from "../ui/menuGate";
import { modalShortcuts } from "../ui/modalGate";
import {
  argsFromKeyEvent,
  ignoresKeyRepeat,
  matchKeymapCommands,
} from "./registry";
import { isButtonActivation, isTypingTarget } from "./typing";

/**
 * Sole window-level Sharecut Studio shortcut listener (governance choke-point).
 * Component-local Escape (e.g. BottomSheet) may use separate listeners —
 * see commands/governance.test.ts allowlist. An open menu owns every key
 * (`menuGate`); an open modal dialog holds every app shortcut but the ones it
 * hands on (`modalGate`: M for a marker in the Record room), so nothing runs
 * behind an in-app confirm. Native keys inside the dialog (typing in its
 * field, Tab, Enter on its buttons) are left to the browser.
 *
 * When several keymap rows share a key (Backspace clip vs track, Escape
 * comment vs clear selection), try each match in catalog order and run the
 * first whose when-clause passes.
 */
export function useDawKeymapListener(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useDawStore.getState();
      if (
        s.commandPaletteOpen ||
        s.bounceDialogOpen ||
        (s.shareDialogOpen && s.project) ||
        peekMenuOpen()
      ) {
        return;
      }
      const handedOn = modalShortcuts();
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
