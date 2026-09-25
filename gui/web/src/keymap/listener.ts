import { useEffect } from "react";
import { COMMANDS } from "../commands/catalog";
import { buildCommandContext, evaluateWhen } from "../commands/context";
import { execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";
import { peekMenuOpen } from "../ui/menuGate";
import {
  argsFromKeyEvent,
  ignoresKeyRepeat,
  matchKeymapCommands,
} from "./registry";
import { isTypingTarget } from "./typing";

/**
 * Sole window-level Sharecut Studio shortcut listener (governance choke-point).
 * Component-local Escape (e.g. BottomSheet) may use separate listeners —
 * see commands/governance.test.ts allowlist.
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
      if (isTypingTarget(e.target)) {
        return;
      }
      if (s.recordPanelOpen) {
        const matches = matchKeymapCommands(e);
        for (const cmd of matches) {
          if (cmd.id !== "record.marker") {
            continue;
          }
          const def = COMMANDS[cmd.id];
          if (!def) {
            continue;
          }
          const ctx = buildCommandContext();
          const gate = evaluateWhen(def.when, ctx);
          if (!gate.ok) {
            continue;
          }
          e.preventDefault();
          void execute(cmd.id, argsFromKeyEvent(e, cmd.id), {
            ctx,
            skipWhen: true,
          });
          return;
        }
        return;
      }
      const matches = matchKeymapCommands(e);
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
          if (ignoresKeyRepeat(e, cmd.id)) {
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
