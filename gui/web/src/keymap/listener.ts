import { useEffect } from "react";
import { COMMANDS } from "../commands/catalog";
import { buildCommandContext, evaluateWhen } from "../commands/context";
import { execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";
import {
  keymapHandoff,
  overlayOpen,
  subscribeModalOpen,
} from "../ui/modalGate";
import {
  argsFromKeyEvent,
  ignoresKeyRepeat,
  matchKeymapCommands,
} from "./registry";
import {
  isButtonActivation,
  isChoiceControlArrow,
  isScrubValue,
  isTypingTarget,
} from "./typing";

/**
 * Sole window-level ShareCut Studio shortcut listener (governance choke-point).
 * Component-local Escape (e.g. BottomSheet) may use separate listeners —
 * see commands/governance.test.ts allowlist. One gate decides what runs while
 * an overlay is open (`keymapHandoff` in `ui/modalGate`): an open menu holds
 * every key; an open modal dialog holds every app shortcut but the ones it
 * hands on (C for a marker on the Record stage), so nothing runs behind an
 * in-app confirm. Native keys inside the dialog (typing in its field, Tab,
 * Enter on its buttons) are left to the browser.
 *
 * A Scrub value (a `[role="spinbutton"]` span, `isScrubValue`) owns every key
 * but Escape while it has focus, as a text field does. A radio keeps the bare
 * arrow keys and a SegmentedControl segment keeps Up and Down
 * (`isChoiceControlArrow`).
 *
 * When several keymap rows share a key (Backspace track or clip;
 * Escape follow or selection), try each match in the order
 * `SHARED_KEY_ORDER` declares and run the first whose when-clause passes.
 */
export function useDawKeymapListener(): void {
  useEffect(() => {
    // Shift+Space was handled on keydown: its keyup must not click the button.
    let hearHeld = false;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holdKey = "";
    const cancelHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
    };
    let held: { code: string; id: string } | null = null;
    const release = () => {
      if (!held) return;
      const { id } = held;
      held = null;
      void execute(id, { on: false }, { skipWhen: true });
    };
    const onBlur = () => {
      cancelHold();
      release();
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") release();
    };
    const onOverlay = () => {
      if (overlayOpen()) release();
    };
    const unsubscribeOverlay = subscribeModalOpen(onOverlay);
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === holdKey) cancelHold();
      if (held && e.code === held.code) release();
      if (e.key !== " " || !hearHeld) return;
      hearHeld = false;
      e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) {
        return;
      }
      if (e.key === "Escape" && overlayOpen()) {
        return;
      }
      const handedOn = keymapHandoff();
      if (handedOn?.length === 0) {
        return;
      }
      if (
        isTypingTarget(e.target) ||
        (e.key !== "Escape" && isScrubValue(e.target)) ||
        isButtonActivation(e) ||
        isChoiceControlArrow(e)
      ) {
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
          if (e.key === " " && e.shiftKey) hearHeld = true;
          if (ignoresKeyRepeat(e, cmd)) {
            return;
          }
          if (cmd.release) {
            held ??= { code: e.code, id: cmd.id };
            await execute(cmd.id, { on: true }, { ctx, skipWhen: true });
            return;
          }
          if (cmd.holdMs) {
            if (!e.repeat && !holdTimer) {
              holdKey = e.key.toLowerCase();
              holdTimer = setTimeout(() => {
                holdTimer = null;
                if (!evaluateWhen(def.when, buildCommandContext()).ok) return;
                void execute(cmd.id, {}, { skipWhen: true });
              }, cmd.holdMs);
            }
            return;
          }
          const result = await execute(cmd.id, argsFromKeyEvent(e, cmd.id), {
            ctx,
            skipWhen: true,
          });
          if (
            result.status === "disabled" &&
            !result.told &&
            (def.mutates || def.announcesRefusal)
          ) {
            useDawStore
              .getState()
              .announceStatus(result.reason, { tone: "error" });
          }
          return;
        }
      })();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      cancelHold();
      release();
      unsubscribeOverlay();
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);
}
