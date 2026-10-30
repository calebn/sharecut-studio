import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEYMAP_COMMANDS, matchKeymapCommands } from "../keymap/registry";
import { isProgrammaticUi, withProgrammaticUi } from "../presence/followSync";
import { useDawStore } from "../state/dawStore";
import { trackEditSave } from "../state/documentSendOrder";
import { minimalProject, sampleTrack } from "../test/fixtures";
import {
  SRC_ROOT,
  sourceFiles,
  srcRelative,
  walkTsFiles,
} from "../test/sourceFiles";
import { GUESTS_HEAR_FULL_MIX } from "../utils/auditionModes";
import { COMMANDS, listCatalogIds } from "./catalog";
import { buildCommandContext, evaluateWhen } from "./context";
import {
  clearRegisteredCommands,
  execute,
  listRegisteredIds,
  registerCommand,
} from "./execute";
import { executePointerCommand } from "./pointer";
import { registerDawCommands } from "./register";

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

/** Allowlisted non-bus keydown sites (component Escape / a11y widgets). */
const KEYDOWN_LISTENER_ALLOWLIST = new Set([
  "keymap/listener.ts",
  // A clip drag in progress takes Escape from the document, wherever focus is, so the cancel does not depend on the clip holding focus.
  "system/Clip.tsx",
  "timeline/ClipBlock.tsx",
  "ui/useDialogModal.ts",
  "ui/useMenuKeyboard.ts",
  "commands/governance.test.ts",
  "stage/edit/ScriptDivider.test.tsx",
  "stage/edit/script/ScriptHost.keys.test.tsx",
  "record/useRecordLiveComments.ts",
  // Sheets and dialogs render through portals; a native root listener keeps their keys out of the stage.
  "review/ReviewStage.tsx",
  // Mod+E exports from anywhere on the Deliver page, including a focused chip or field.
  "stages/deliver/DeliverStage.tsx",
  // Escape keeps the link while Stop sharing is asking, wherever focus is, so the cancel does not depend on the row holding focus.
  "stages/deliver/ShareSection.tsx",
  // A test listens at the window the way the app keymap does, to prove the keys the pane handles never reach it.
  "system/ScriptPane.select.test.tsx",
  // A drag in progress on a ruler handle, the ruler body or a marker takes Escape from the document, wherever focus is, so the cancel does not depend on the grabbed element holding focus.
  "system/useGrab.ts",
  // The same window-level listener, to prove the keys the ruler and the marker lane handle never reach the keymap.
  "system/Ruler.test.tsx",
  "system/MarkerLane.test.tsx",
  // The same window-level listener, to prove the keys a focused envelope point handles never reach the keymap, and the ones it leaves do.
  "system/Envelope.test.tsx",
  // Esc cancels a script selection drag in the capture phase, so it never also clears the selection or reaches the keymap.
  "system/useScriptGestures.ts",
  "system/ScriptPane.gestures.test.tsx",
  // Reads only whether Alt is down so the Split guide follows a press made while the pointer rests; it binds no command.
  "timeline/useSplitAtPointer.ts",
  // The same window-level listener, to prove the keys the Inspector sheet handles never reach the keymap.
  "system/InspectorSheet.test.tsx",
]);

const ON_KEY_DOWN_ALLOWLIST = new Set([
  "transcript/EditBoundaryMarkView.tsx",
  "timeline/TimeRulerView.tsx",
  "timeline/MarkerLaneView.tsx",
  "timeline/EnvelopeOverlayView.tsx",
  // The ARIA tablist pattern: arrows, Home and End move among the tabs.
  "ui/Tabs.tsx",
  // Arrows, Home and End move the one tab stop among the cards.
  "system/ProjectCard.tsx",
  // Enter and comma add a chip, and Backspace in an empty field removes the last term.
  "system/ChipInput.tsx",
  // Escape closes the Open other popover from its field and its buttons.
  "stages/home/OpenOther.tsx",
  // Escape closes the Review comment field.
  "stage/hosts/useReviewComments.tsx",
  // The time field: arrows step, Enter commits and Escape reverts, like a spin box.
  "system/TimeField.tsx",
  // A focused clip trim handle moves with the arrow keys, 10 ms, 100 ms with Shift.
  "stages/deliver/ClipTrimWave.tsx",
  // Escape cancels only this region's active pointer gesture.
  "timeline/PendingEditOverlayView.tsx",
  // Focused clip handles route key edits locally; Escape cancels their preview.
  "timeline/ClipBlockView.tsx",
  "inspector/views/TranscriptWordInspector.tsx",
  "transcript/TranscriptWordbar.tsx",
  // The separator pattern: arrows resize the Script pane, Enter resets it.
  "stage/edit/ScriptDivider.tsx",
  "tracks/TrackHeaderView.tsx",
  "tracks/TrackMuteSoloButtonsView.tsx",
  "tracks/TrackHeader.tsx",
  // Keep clip clearing on the focused button from toggling global playback.
  "tracks/TrackPlaybackMeter.tsx",
  // Palette search: Enter runs the top match and arrows step through results.
  "stage/dialogs/CommandPaletteView.tsx",
  // Enter sends the note and Shift+Enter adds a line, as in the Composer.
  "system/ActionBarInline.tsx",
  // Enter posts the comment and Shift+Enter adds a line (Return is a new line on
  // coarse pointers); Cmd or Ctrl+Enter also posts. Enter in the guest name field
  // moves to the comment field.
  "system/Composer.tsx",
  // A focused suggestion handle moves with the arrow keys, 0.5 s with Shift.
  "system/SuggestionWaveform.tsx",
  // Enter or Space on a live Record button opens the stop question, since a
  // key cannot hold.
  "system/RecordButton.tsx",
  // The Stage design system palette (owner-accepted): its combobox keys stay in
  // the view, arrows, Enter and Escape on the search field and Enter or Space on a row.
  "system/Palette.tsx",
  // The scrub field is a spinbutton: arrows, Home, End, Enter and F2 edit its own value and stop there.
  "system/ScrubField.tsx",
  // The script pane's words, cut pills and suggested runs are one tab stop: Left and Right, Home and End move among them, Up and Down move by line, Shift extends the selection, Alt+Shift+Left and Right move its start, Enter selects a word or, on a selected word, starts Fix text, F2 starts Fix text, and Esc clears the selection. The margin controls (speaker name, time) take Enter and Space like buttons. Space is left alone for Play/Pause.
  "system/ScriptPane.tsx",
  // The seam's button hands its keys and a roving tab index to the host that moves focus among marks; the script pane does so for its cut pills, which join the pane's one tab stop.
  "system/Seam.tsx",
  // The notes composer is one field: Enter sends and Shift+Enter adds a line, and an IME's own Enter (isComposing or keyCode 229) never sends.
  "system/NotesRail.tsx",
  // A clip's body and handles: Escape cancels a drag in progress, Left and Right on a handle nudge its edge 10 ms (Shift 100 ms) like a slider, and every other key goes to the lane that hosts the clip.
  "system/Clip.tsx",
  // Shift with Up or Down on a track header asks the host to move the track one place; the name button keeps its own Enter and Space.
  "system/TrackHeader.tsx",
  // A selection grip is a slider: arrows, Home and End move its edge one place on or back, or to the first or last place.
  "system/SelectionHandles.tsx",
  // The ruler is one slider on the playhead: Left and Right move it one tick (Shift ten), Home and End go to the ends, and Alt with Left or Right walks focus to the selection handles, which nudge their edge 10 ms (Shift 100 ms) with Left and Right.
  "system/Ruler.tsx",
  // A marker's button and a bracket's edge sliders: Left and Right on a selected chapter or bracket, or on an edge, nudge it 0.1 s (Shift 1 s), and Alt with Left or Right walks focus along a bracket's edges. Every other key goes to the keymap.
  "system/MarkerLane.tsx",
  // A focused envelope point is a slider of its level: Left and Right nudge its time 10 ms (Shift 100 ms), Up and Down its level 0.5 dB (Shift 5, Alt 0.05), Alt with Left or Right walks focus among the points, Enter and Space select it, and Backspace and Delete remove it when selected. It stops those keys so a clip is never cut or the playhead moved; every other key goes to the keymap.
  "system/Envelope.tsx",
  // The Inspector sheet closes on Escape unless a field inside took it, and its grip is a vertical slider: Up and Down step the detents, Home and End go to the ends, Enter and Space toggle half and dock. The inline name field commits on Enter and puts the name back on Escape.
  "system/InspectorSheet.tsx",
  // The inline Fix text field commits on Enter and Tab and puts the words back on Escape.
  // With apply on activate the person picker is a radiogroup of radio buttons: arrows, Home and End move the focus ring and pick nobody; click, Space and Enter pick.
  "system/PersonPicker.tsx",
  // The inline Fix text field commits on Enter and Tab and puts the words back on Escape; a rename inside the speaker popover is the same field with leaving turned to cancel.
  "stages/edit/FixTextField.tsx",
  // The Find bar: Enter and Down step to the next hit, Shift+Enter and Up to the previous one, Mod+Shift+Enter cuts them all, and Escape closes the bar from any control in it.
  "stages/edit/FindBar.tsx",
  "commands/governance.test.ts",
]);

describe("command bus", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.setState({
      timelineFocused: true,
      stage: "edit",
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

  it("disables a timeline command when the timeline is not focused", async () => {
    useDawStore.setState({ timelineFocused: false, stage: "review" });
    const r = await execute("view.waveformZoomIn");
    expect(r.status).toBe("disabled");
  });

  it("runs pointer commands past keyboard gates and applies their effect", async () => {
    useDawStore.setState({
      timelineFocused: false,
      stage: "review",
      waveformAmpZoom: 1,
    });
    expect((await execute("view.waveformZoomIn")).status).toBe("disabled");

    expect(await executePointerCommand("view.waveformZoomIn")).toEqual({
      status: "ok",
    });
    expect(useDawStore.getState().waveformAmpZoom).toBeGreaterThan(1);
  });

  it("runs a timeline command when context allows", async () => {
    useDawStore.setState({ waveformAmpZoom: 1 });
    const r = await execute("view.waveformZoomIn");
    expect(r.status).toBe("ok");
    expect(useDawStore.getState().waveformAmpZoom).toBeGreaterThan(1);
  });

  it("rejects guest comment resolution even when a caller skips the UI gate", async () => {
    useDawStore.setState({ guestMode: "edit" });
    expect(
      await execute(
        "comment.resolve",
        { commentId: "c1", resolved: true, by: "Host" },
        { skipWhen: true },
      ),
    ).toEqual({ status: "disabled", reason: "Comment resolve is host-only" });
  });

  it("requires a known comment and explicit resolution arguments", async () => {
    expect(await execute("comment.resolve", { commentId: "c1" })).toEqual({
      status: "disabled",
      reason: "Invalid comment resolve arguments",
    });
    expect(
      await execute("comment.resolve", {
        commentId: "missing",
        resolved: true,
        by: "Host",
      }),
    ).toEqual({ status: "disabled", reason: "Unknown comment" });
  });

  it("rejects an already resolved comment before issuing a mutation", async () => {
    useDawStore.setState({
      project: {
        meta: { name: "t" },
        timeline_duration_sec: 100,
        tracks: [],
        comments: [{ id: "c1", resolved: true }],
      } as never,
    });
    expect(
      await execute("comment.resolve", {
        commentId: "c1",
        resolved: true,
        by: "Host",
      }),
    ).toEqual({ status: "disabled", reason: "Comment is already resolved" });
  });

  it("registers phase-1 and phase-2 command handlers", () => {
    const ids = listRegisteredIds();
    expect(ids).toEqual(listCatalogIds().sort());
    for (const id of [
      "transport.togglePlay",
      "transport.stop",
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
      "comment.resolve",
      "history.undo",
      "history.redo",
      "ui.toggleCommandPalette",
      "presence.follow",
      "presence.unfollow",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("local transport commands unfollow", async () => {
    useDawStore
      .getState()
      .setProject(minimalProject({ tracks: [sampleTrack()] }));
    useDawStore.setState({ followingClientId: "a", isPlaying: false });
    expect((await execute("transport.togglePlay")).status).toBe("ok");
    expect(useDawStore.getState().followingClientId).toBeNull();
  });

  it("disables FX audition for guests", async () => {
    useDawStore.setState({ guestMode: "view", auditionMode: "mix" });
    expect(await execute("transport.audition", { mode: "fx" })).toEqual({
      status: "disabled",
      reason: GUESTS_HEAR_FULL_MIX,
    });
    expect(useDawStore.getState().auditionMode).toBe("mix");
    expect(await execute("transport.audition", { mode: "mix" })).toEqual({
      status: "ok",
    });
  });
});

describe("command governance", () => {
  it("centralizes pointer gate bypasses", () => {
    const pointerPolicyExceptions = new Set([
      "agentic/webmcp.ts",
      "commands/pointer.ts",
      "keymap/listener.ts",
    ]);
    const offenders: string[] = [];
    const inlineBypass = /skipWhen\s*:\s*true\b/g;

    for (const { rel, text } of sourceFiles()) {
      if (rel.includes(".test.")) {
        continue;
      }
      const count = [...text.matchAll(inlineBypass)].length;
      if (!count) {
        continue;
      }
      if (!pointerPolicyExceptions.has(rel)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("registers no view.focus* no-op commands (#701)", () => {
    expect(
      Object.keys(COMMANDS).filter((id) => id.startsWith("view.focus")),
    ).toEqual([]);
  });

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

  it("gates host project commands on a loaded host project", async () => {
    const hostProjectCommands = [
      "export.bounce",
      "export.deliverables",
      "export.transcript",
      "share.manage",
      "record.createRoom",
      "record.copyGuestLink",
      "edit.addChapter",
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

  it("canUndo and canRedo follow the history flags, canUndo also in-flight saves and guests", async () => {
    const history = (can_undo: boolean, can_redo: boolean) =>
      ({
        meta: { name: "t" },
        tracks: [],
        history: { can_undo, can_redo },
      }) as never;
    useDawStore.setState({
      projectPath: "/tmp/ep",
      project: null,
      guestMode: null,
    });
    expect(evaluateWhen("canUndo", buildCommandContext())).toEqual({
      ok: false,
      reason: "No project loaded",
    });

    useDawStore.setState({ project: history(false, false) });
    const idle = buildCommandContext();
    expect(evaluateWhen("canUndo", idle)).toEqual({
      ok: false,
      reason: "Nothing to undo",
    });
    expect(evaluateWhen("canRedo", idle)).toEqual({
      ok: false,
      reason: "Nothing to redo",
    });

    useDawStore.setState({ project: history(true, true) });
    const ready = buildCommandContext();
    expect(evaluateWhen("canUndo", ready)).toEqual({ ok: true });
    expect(evaluateWhen("canRedo", ready)).toEqual({ ok: true });

    useDawStore.setState({ project: history(false, false) });
    let landed!: () => void;
    const save = trackEditSave(
      "/tmp/ep",
      new Promise<void>((resolve) => {
        landed = resolve;
      }),
    );
    const busy = buildCommandContext();
    expect(evaluateWhen("canUndo", busy)).toEqual({ ok: true });
    expect(evaluateWhen("canRedo", busy).ok).toBe(false);
    landed();
    await save;
    await Promise.resolve();
    expect(evaluateWhen("canUndo", buildCommandContext()).ok).toBe(false);

    useDawStore.setState({ guestMode: "editor" });
    const guest = buildCommandContext();
    expect(evaluateWhen("canUndo", guest)).toEqual({ ok: true });
    expect(evaluateWhen("canRedo", guest)).toEqual({ ok: true });
    useDawStore.setState({ guestMode: null });
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
      const rel = srcRelative(file);
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
      const rel = srcRelative(file);
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

  it("evaluateWhen editorFocused matches buildCommandContext", () => {
    useDawStore.setState({ timelineFocused: false, stage: "review" });
    const ctx = buildCommandContext();
    expect(evaluateWhen("editorFocused", ctx).ok).toBe(false);
    useDawStore.setState({ timelineFocused: true });
    expect(evaluateWhen("editorFocused", buildCommandContext()).ok).toBe(true);
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
    registerCommand("view.zoomIn", () => ({
      status: "disabled",
      reason: "no",
    }));
    useDawStore.setState({ followingClientId: "x" });
    await execute("track.muteToggle", {}, { skipWhen: true });
    expect(useDawStore.getState().followingClientId).toBe("x");
    await execute("track.soloToggle", {}, { skipWhen: true });
    expect(useDawStore.getState().followingClientId).toBe("x");
    await execute("view.zoomIn", {}, { skipWhen: true });
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
