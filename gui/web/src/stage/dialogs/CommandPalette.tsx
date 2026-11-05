import { useEffect, useMemo, useState } from "react";
import { listRecentProjects, type RecentProject } from "../../api";
import { buildCommandContext } from "../../commands/context";
import { executePointerCommand } from "../../commands/pointer";
import { clearKeymapOverride, setKeymapOverride } from "../../keymap/remaps";
import { disambiguatedNames } from "../../presence/colors";
import { sessionClientList } from "../../presence/roster";
import { useLivePresenceClients } from "../../presence/useLivePresenceClients";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { CommandPaletteView } from "./CommandPaletteView";
import { paletteCommands, paletteEntries } from "./commandPaletteRows";
import { readPaletteRecent, rememberPaletteRecent } from "./paletteRecent";
import type { PaletteEntry } from "./paletteSearch";

/**
 * Command palette (Commands and shortcuts): every runnable catalog command,
 * searchable, with its keys. Open via ?, Transport Menu → Help, or the phone
 * More hub. Rows are rebuilt each time it opens so their reasons match now.
 */
export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen, setGesturesSheetOpen } =
    useDaw((s) => ({
      commandPaletteOpen: s.chrome.commandPaletteOpen,
      setCommandPaletteOpen: s.setCommandPaletteOpen,
      setGesturesSheetOpen: s.setGesturesSheetOpen,
    }));

  const {
    sessionClients,
    localClientId,
    followingClientId,
    project,
    projectPath,
  } = useDaw((s) => ({
    sessionClients: sessionClientList(s.sessionClients),
    localClientId: s.localClientId,
    followingClientId: s.followingClientId,
    project: s.project,
    projectPath: s.projectPath,
  }));
  const { others } = useLivePresenceClients(sessionClients, localClientId);
  const [recent, setRecent] = useState<string[]>([]);
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const hostLink = buildCommandContext().canManageProjects;

  useEffect(() => {
    if (!commandPaletteOpen) {
      return;
    }
    setRecent(readPaletteRecent());
    if (!hostLink) {
      setProjects([]);
      return;
    }
    // Projects are the host's recent list; a failed fetch just leaves the group out.
    const controller = new AbortController();
    listRecentProjects(controller.signal)
      .then(setProjects)
      .catch(() => undefined);
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
      recent={recent}
      onRunEntry={(entry: PaletteEntry) => {
        setRecent(rememberPaletteRecent(entry.id));
        setCommandPaletteOpen(false);
        void executePointerCommand(entry.commandId, entry.args).then(
          (result) => {
            if (result.status === "disabled") {
              useDawStore.getState().announceStatus(result.reason);
            }
          },
        );
      }}
      commands={
        commandPaletteOpen ? paletteCommands(buildCommandContext()) : []
      }
      onClose={() => setCommandPaletteOpen(false)}
      onOpenGestures={() => {
        setCommandPaletteOpen(false);
        setGesturesSheetOpen(true);
      }}
      onRun={(id) => {
        setRecent(rememberPaletteRecent(id));
        // Close first: a command may open its own dialog, and dialogs never stack.
        setCommandPaletteOpen(false);
        void executePointerCommand(id).then((result) => {
          if (result.status === "disabled") {
            useDawStore.getState().announceStatus(result.reason);
          }
        });
      }}
      onRemap={(id, trimmedKey) => {
        if (!trimmedKey) {
          clearKeymapOverride(id);
          return;
        }
        setKeymapOverride(id, [trimmedKey]);
      }}
    />
  );
}
