import { runPointerCommand } from "../commands/pointer";

/**
 * Live handlers for `TransportPlayControls`: the same `transport.*` commands
 * the keyboard and command palette run (what a bare `CommandButton` did).
 */
export const transportPlayHandlers = {
  onTogglePlay: () => {
    runPointerCommand("transport.togglePlay");
  },
  onStop: () => {
    runPointerCommand("transport.stop");
  },
} as const;
