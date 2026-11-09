import { useEffect, useMemo, useReducer, useState } from "react";
import { listRecentProjects, type RecentProject } from "../../api";
import { buildCommandContext } from "../../commands/context";
import { execute } from "../../commands/execute";
import { executePointerCommand } from "../../commands/pointer";
import { runAndAnnounceRefusal } from "../../commands/refusal";
import { bareKeyConflict } from "../../keymap/registry";
import { clearKeymapOverride, setKeymapOverride } from "../../keymap/remaps";
import { disambiguatedNames } from "../../presence/colors";
import { sessionClientList } from "../../presence/roster";
import { useLivePresenceClients } from "../../presence/useLivePresenceClients";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { SessionClient } from "../../types/session";
import { CommandPaletteView } from "./CommandPaletteView";
import { paletteCommands, paletteEntries } from "./commandPaletteRows";
import { readPaletteRecent, rememberPaletteRecent } from "./paletteRecent";
import { PALETTE_GESTURES, type PaletteEntry } from "./paletteSearch";

const NO_CLIENTS: SessionClient[] = [];
const NO_GESTURES: readonly never[] = [];

/**
 * Command palette (Commands and shortcuts): every runnable catalog command,
 * searchable, with its keys. Open via ?, Transport Menu → Help, or the phone
 * More hub. Rows are rebuilt each time it opens so their reasons match now.
 * On Home (`scope="home"`) it lists only the commands that make sense with no
 * project open, and opens on its Help group. A touch pointer adds the Gestures
 * rows, except on Home, which has no timeline to gesture on.
 */
export function CommandPalette({ scope }: { scope?: "home" }) {
  const { commandPaletteOpen, setCommandPaletteOpen, coarse } = useDaw((s) => ({
    commandPaletteOpen: s.chrome.commandPaletteOpen,
    setCommandPaletteOpen: s.setCommandPaletteOpen,
    coarse: s.pointerKind === "coarse",
  }));
  // A remap writes localStorage only; this re-reads the shown key.
  const [, keymapChanged] = useReducer((n: number) => n + 1, 0);

  const {
    sessionClients,
    localClientId,
    followingClientId,
    project,
    projectPath,
  } = useDaw((s) => ({
    // The roster only feeds People rows, so a closed palette ignores presence frames.
    sessionClients: s.chrome.commandPaletteOpen
      ? sessionClientList(s.sessionClients)
      : NO_CLIENTS,
    localClientId: s.localClientId,
    followingClientId: s.followingClientId,
    project: s.project,
    projectPath: s.projectPath,
  }));
  const { others } = useLivePresenceClients(sessionClients, localClientId);
  const [recent, setRecent] = useState<string[]>([]);
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [wasOpen, setWasOpen] = useState(commandPaletteOpen);
  const hostLink = buildCommandContext().canManageProjects;

  // Read Recent in the render that opens the palette, so its first frame has it.
  if (commandPaletteOpen !== wasOpen) {
    setWasOpen(commandPaletteOpen);
    if (commandPaletteOpen) {
      setRecent(readPaletteRecent());
      setProjects([]);
    }
  }

  useEffect(() => {
    if (!commandPaletteOpen || !hostLink) {
      return;
    }
    // Projects are the host's recent list; a failed fetch leaves the group out.
    const controller = new AbortController();
    listRecentProjects(controller.signal)
      .then(setProjects)
      .catch(() => {
        if (!controller.signal.aborted) {
          setProjects([]);
        }
      });
    return () => controller.abort();
  }, [commandPaletteOpen, hostLink]);

  const entries = useMemo(() => {
    if (!commandPaletteOpen) {
      return [];
    }
    const names = disambiguatedNames(others);
    return paletteEntries(buildCommandContext(), {
      chapters: project?.chapters ?? [],
      projects,
      projectPath,
      people: others.map((c) => ({
        clientId: c.client_id,
        name: names.get(c.client_id) ?? c.client_id,
        role: c.role,
        following: c.client_id === followingClientId,
      })),
    });
  }, [
    commandPaletteOpen,
    others,
    project,
    projects,
    projectPath,
    followingClientId,
  ]);

  return (
    <CommandPaletteView
      open={commandPaletteOpen}
      entries={entries}
      gestures={scope !== "home" && coarse ? PALETTE_GESTURES : NO_GESTURES}
      recent={recent}
      onRunEntry={(entry: PaletteEntry) => {
        setRecent(rememberPaletteRecent(entry.id));
        setCommandPaletteOpen(false);
        // Re-check the command's gate now: the row was built when the palette opened.
        void runAndAnnounceRefusal(() => execute(entry.commandId, entry.args));
      }}
      commands={
        commandPaletteOpen ? paletteCommands(buildCommandContext(), scope) : []
      }
      leadGroup={scope === "home" ? "help" : undefined}
      onClose={() => setCommandPaletteOpen(false)}
      onRun={(id) => {
        setRecent(rememberPaletteRecent(id));
        // Close first: a command may open its own dialog, and dialogs never stack.
        setCommandPaletteOpen(false);
        void runAndAnnounceRefusal(() => executePointerCommand(id));
      }}
      onRemap={(id, trimmedKey) => {
        if (!trimmedKey) {
          clearKeymapOverride(id);
          keymapChanged();
          return;
        }
        const conflict = bareKeyConflict(id, trimmedKey);
        if (conflict) {
          useDawStore
            .getState()
            .announceStatus(`${trimmedKey} is already ${conflict.label}`);
          return;
        }
        setKeymapOverride(id, [trimmedKey]);
        keymapChanged();
      }}
    />
  );
}
