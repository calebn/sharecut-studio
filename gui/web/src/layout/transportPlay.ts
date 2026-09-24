import { execute } from "../commands/execute";

/**
 * Live handlers for `TransportPlayControls`: the same `transport.*` commands
 * the keyboard and command palette run (what a bare `CommandButton` did).
 */
export const transportPlayHandlers = {
  onTogglePlay: () => {
    void execute("transport.togglePlay", {}, { skipWhen: true });
  },
  onStop: () => {
    void execute("transport.stop", {}, { skipWhen: true });
  },
} as const;
