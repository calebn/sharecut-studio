import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEYMAP_COMMANDS, matchKeymapCommands } from "../keymap/registry";
import { isProgrammaticUi, withProgrammaticUi } from "../presence/followSync";
import { useDawStore } from "../state/dawStore";
import { COMMANDS, listCatalogIds } from "./catalog";
import { buildCommandContext, evaluateWhen } from "./context";
import {
  clearRegisteredCommands,
  execute,
  listRegisteredIds,
  registerCommand,
} from "./execute";
import { registerDawCommands } from "./register";

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") {
      continue;
    }
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walkTsFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const SRC_ROOT = join(__dirname, "..");

type ManifestCapability = {
  id: string;
  label: string;
  gates?: string[];
  surfaces?: { command?: string; keyboard?: string };
};

const MANIFEST_CAPABILITIES: ManifestCapability[] = JSON.parse(
  readFileSync(
    join(SRC_ROOT, "../../../contracts/capabilities.manifest.json"),
    "utf-8",
  ),
).capabilities;

/**
 * Known manifest `gates` that do not list the catalog `when` yet (composite or
 * surface-specific gates). Shrink this list; do not grow it (#221).
 */
const MANIFEST_GATE_DRIFT_ALLOWLIST = new Set([
  "track.moveUp",
  "track.moveDown",
  "edit.copy",
  "view.zoomIn",
  "view.zoomOut",
  "view.fit",
  "view.waveformZoomIn",
  "view.waveformZoomOut",
  "transcript.correctIntent",
  "transcript.selectIntent",
  "edit.trimClipEdge",
  "edit.rollClipJoin",
  "edit.setClipFade",
  "view.focusEditBoundary",
  "view.focusCutAwayWord",
]);

/** Allowlisted non-bus keydown sites (component Escape / a11y widgets). */
const KEYDOWN_LISTENER_ALLOWLIST = new Set([
  "keymap/listener.ts",
  "ui/useDialogModal.ts",
  "ui/Menu.tsx",
  "commands/governance.test.ts",
  "record/useRecordLiveComments.ts",
]);

const ON_KEY_DOWN_ALLOWLIST = new Set([
  "timeline/TimeRuler.tsx",
  "timeline/EnvelopeOverlay.tsx",
  "inspector/views/TranscriptWordInspector.tsx",
  "layout/BottomTabsSplitter.tsx",
  "tracks/TrackHeader.tsx",
  "commands/governance.test.ts",
]);

describe("command bus", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.setState({
      timelineFocused: true,
      activeTab: "transcript",
      commentMode: false,
      projectPath: "/tmp/ep",
      guestMode: null,
      project: {
        meta: { name: "t" },
        timeline_duration_sec: 100,
        tracks: [],
      } as never,
    });
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("returns unknown for missing ids", async () => {
    expect(await execute("no.such")).toEqual({ status: "unknown" });
  });

  it("disables tool.select when timeline not focused", async () => {
    useDawStore.setState({ timelineFocused: false, activeTab: "history" });
    const r = await execute("tool.select");
    expect(r.status).toBe("disabled");
  });

  it("sets tool mode when context allows", async () => {
    const r = await execute("tool.select");
    expect(r.status).toBe("ok");
    expect(useDawStore.getState().toolMode).toBe("select");
  });

  it("registers phase-1 and phase-2 command handlers", () => {
    const ids = listRegisteredIds();
    for (const id of [
      "transport.togglePlay",
      "transport.stop",
      "tool.select",
      "tool.blade",
      "edit.bladeCut",
      "edit.delete",
      "edit.rippleDelete",
      "edit.clearSelection",
      "edit.moveClips",
      "track.selectAll",
      "track.deselectAll",
      "track.muteToggle",
      "track.soloToggle",
      "track.remove",
      "track.reorder",
      "track.moveUp",
      "track.moveDown",
      "navigation.goToStart",
      "navigation.goToEnd",
      "view.zoomIn",
      "view.zoomOut",
      "view.fit",
      "view.waveformZoomIn",
      "view.waveformZoomOut",
      "review.toggleCommentMode",
      "history.undo",
      "history.redo",
      "ui.toggleCommandPalette",
      "presence.follow",
      "presence.unfollow",
      "view.setTab",
      "view.setMobileMode",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("local transport commands unfollow", async () => {
    useDawStore.setState({ followingClientId: "a", isPlaying: false });
    expect((await execute("transport.togglePlay")).status).toBe("ok");
    expect(useDawStore.getState().followingClientId).toBeNull();
  });

  it("disables FX audition for guests", async () => {
    useDawStore.setState({ guestMode: "view", auditionMode: "mix" });
    expect(await execute("transport.audition", { mode: "fx" })).toEqual({
      status: "disabled",
      reason: "guests hear Mix only",
    });
    expect(useDawStore.getState().auditionMode).toBe("mix");
    expect(await execute("transport.audition", { mode: "mix" })).toEqual({
      status: "ok",
    });
  });

  it("rejects unknown More destinations including mix", async () => {
    expect(
      await execute("view.setMobileMode", {
        mode: "more",
        destination: "mix",
      }),
    ).toEqual({
      status: "disabled",
      reason: "destination unknown",
    });
    expect(useDawStore.getState().moreDestination).not.toBe("mix");
  });
});

describe("command governance", () => {
  it("every keymap id exists in the command catalog", () => {
    for (const k of KEYMAP_COMMANDS) {
      expect(COMMANDS[k.id], k.id).toBeDefined();
      expect(k.when).toBe(COMMANDS[k.id].when);
    }
  });

  it("keeps labels consistent between the keymap and catalog", () => {
    for (const keymapCommand of KEYMAP_COMMANDS) {
      const catalogCommand = COMMANDS[keymapCommand.id];
      if (catalogCommand) {
        expect(catalogCommand.label, keymapCommand.id).toBe(
          keymapCommand.label,
        );
      }
    }
  });

  it("keeps manifest labels in step with keyboard commands", () => {
    for (const cap of MANIFEST_CAPABILITIES) {
      const commandId = cap.surfaces?.command;
      if (!commandId || !cap.surfaces?.keyboard || !COMMANDS[commandId]) {
        continue;
      }
      expect(cap.label, cap.id).toBe(COMMANDS[commandId].label);
    }
  });

  it("lists each catalog when-clause in the manifest gates", () => {
    const drift: string[] = [];
    for (const cap of MANIFEST_CAPABILITIES) {
      const commandId = cap.surfaces?.command;
      const def = commandId ? COMMANDS[commandId] : undefined;
      if (!def || MANIFEST_GATE_DRIFT_ALLOWLIST.has(def.id)) {
        continue;
      }
      if (!(cap.gates ?? []).includes(def.when)) {
        drift.push(
          `${def.id}: when=${def.when} gates=${(cap.gates ?? []).join(",")}`,
        );
      }
    }
    expect(drift).toEqual([]);
  });

  it("gates host project commands on a loaded host project", async () => {
    const hostProjectCommands = [
      "export.bounce",
      "export.deliverables",
      "share.manage",
      "record.openPanel",
    ];
    for (const id of hostProjectCommands) {
      expect(COMMANDS[id].when, id).toBe("hostProjectLoaded");
    }
    clearRegisteredCommands();
    registerDawCommands();

    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      project: { meta: { name: "t" }, tracks: [] } as never,
    });
    expect(evaluateWhen("hostProjectLoaded", buildCommandContext()).ok).toBe(
      true,
    );

    useDawStore.setState({ project: null });
    const ctx = buildCommandContext();
    const noProject = { ok: false, reason: "No project loaded" };
    expect(evaluateWhen("canSuggestStructural", ctx)).toEqual(noProject);
    expect(evaluateWhen("hostProjectLoaded", ctx)).toEqual(noProject);
    for (const id of hostProjectCommands) {
      // Handlers (menu clicks skip when) report the same reason as the when-clause.
      expect(await execute(id, {}, { skipWhen: true }), id).toEqual({
        status: "disabled",
        reason: "No project loaded",
      });
    }

    useDawStore.setState({
      projectPath: "share:token",
      guestMode: "edit",
      project: { meta: { name: "t" }, tracks: [] } as never,
    });
    expect(evaluateWhen("hostProjectLoaded", buildCommandContext()).ok).toBe(
      false,
    );
    clearRegisteredCommands();
  });

  it("every keybinding declares a when predicate", () => {
    for (const k of KEYMAP_COMMANDS) {
      expect(k.when).toBeTruthy();
    }
  });

  it("catalog lists commands including unbound actions", () => {
    expect(listCatalogIds()).toContain("edit.bladeCut");
    expect(listCatalogIds()).toContain("transport.seek");
  });

  it("only allowlisted files attach window keydown listeners", () => {
    const files = walkTsFiles(SRC_ROOT);
    const offenders: string[] = [];
    const re = /addEventListener\(\s*["'`]keydown["'`]/;
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      const text = readFileSync(file, "utf8");
      if (re.test(text) && !KEYDOWN_LISTENER_ALLOWLIST.has(rel)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("limits onKeyDown handlers to allowlisted widgets", () => {
    const files = walkTsFiles(SRC_ROOT);
    const offenders: string[] = [];
    const re = /\bonKeyDown\s*=/;
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      if (rel.includes(".test.")) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      if (re.test(text) && !ON_KEY_DOWN_ALLOWLIST.has(rel)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("evaluateWhen layoutFocused matches buildCommandContext", () => {
    useDawStore.setState({ timelineFocused: false, activeTab: "history" });
    const ctx = buildCommandContext();
    expect(evaluateWhen("layoutFocused", ctx).ok).toBe(false);
    useDawStore.setState({ timelineFocused: true });
    expect(evaluateWhen("layoutFocused", buildCommandContext()).ok).toBe(true);
  });

  it("Shift+ArrowUp matches amp zoom and not track.moveUp", () => {
    const ids = matchKeymapCommands({
      key: "ArrowUp",
      code: "ArrowUp",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    }).map((c) => c.id);
    expect(ids).toContain("view.waveformZoomIn");
    expect(ids).not.toContain("track.moveUp");
  });
});

describe("breaksFollow", () => {
  afterEach(() => {
    clearRegisteredCommands();
  });

  it("unfollows after a successful navigation command", async () => {
    clearRegisteredCommands();
    for (const [id, def] of Object.entries(COMMANDS)) {
      if (!def.breaksFollow) {
        continue;
      }
      registerCommand(id, () => ({ status: "ok" }));
      useDawStore.setState({ followingClientId: "x" });
      await execute(id, {}, { skipWhen: true });
      expect(useDawStore.getState().followingClientId, id).toBeNull();
    }
  });

  it("does not unfollow mute, solo, or a disabled navigation command", async () => {
    clearRegisteredCommands();
    registerCommand("track.muteToggle", () => ({ status: "ok" }));
    registerCommand("track.soloToggle", () => ({ status: "ok" }));
    registerCommand("view.setTab", () => ({
      status: "disabled",
      reason: "no",
    }));
    useDawStore.setState({ followingClientId: "x" });
    await execute("track.muteToggle", {}, { skipWhen: true });
    expect(useDawStore.getState().followingClientId).toBe("x");
    await execute("track.soloToggle", {}, { skipWhen: true });
    expect(useDawStore.getState().followingClientId).toBe("x");
    await execute("view.setTab", {}, { skipWhen: true });
    expect(useDawStore.getState().followingClientId).toBe("x");
  });

  it("keeps follow under programmatic UI", () => {
    useDawStore.setState({ followingClientId: "x" });
    withProgrammaticUi(() => {
      expect(isProgrammaticUi()).toBe(true);
    });
    expect(isProgrammaticUi()).toBe(false);
    expect(useDawStore.getState().followingClientId).toBe("x");
  });
});

describe("registerCommand isolation", () => {
  it("custom handler can be registered for tests", async () => {
    clearRegisteredCommands();
    registerCommand("transport.togglePlay", () => ({ status: "ok" }));
    // catalog still requires known id
    expect((await execute("transport.togglePlay")).status).toBe("ok");
  });
});
