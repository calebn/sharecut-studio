import { describe, expect, it } from "vitest";
import { INVENTORY_IDS } from "./storyInventory";

/**
 * Every non-interaction surface in the UI inventory and the story titles that
 * render it. A story title lists every export of that file, so one title can
 * cover several IDs. A surface is either covered, marked not a surface with a
 * reason, or outside the React app. There is no pending state.
 */
const COVERED: Record<string, string[]> = {
  "PNL-TRANSCRIPT": [
    "Templates/Editor · Transcript panel",
    "Templates/TranscriptTurn",
    "System/ScriptPane",
    "Stages/Edit/ScriptPane",
  ],
  "CMP-FINDREPLACE": [
    "Templates/Editor · Transcript panel",
    "Stages/Edit/FindBar",
  ],
  "DLG-PRECISION": [
    "Templates/Editor · Precision boundary dialog",
    "System/ScrubField",
    "System/Seam",
  ],
  "PNL-COMMENTS": [
    "Templates/Editor · Comments panel",
    "Templates/CommentCard",
    "Templates/CommentCompose",
  ],
  "CMP-GUEST-NAME": ["Templates/Editor · Comments panel"],
  "DLG-STEP-PARAMS": ["Stages/Prepare/AdvancedSteps"],
  "PNL-PIPELINE": ["Stages/Prepare/AdvancedSteps", "Stages/Prepare/ReadyList"],
  "PNL-TIGHTEN": ["Templates/Editor · Tighten panel"],
  "PNL-IMPACT": ["Templates/Editor · Impact panel"],
  "PNL-HISTORY": ["Templates/Editor · History panel"],
  "INS-PEEK": ["Templates/Editor · Inspector · Peek"],
  "INS-RANGE": ["Templates/Editor · Inspector · Range", "System/ScrubField"],
  "INS-WORD": ["Templates/Editor · Inspector · Word"],
  "INS-COMMENT": ["Templates/Editor · Inspector · Comment"],
  "INS-SOCIAL": [
    "Templates/Editor · Inspector · Social clip",
    "System/ScrubField",
    "System/Marker",
  ],
  "INS-CHAPTER": [
    "Templates/Editor · Inspector · Chapter",
    "System/ScrubField",
    "System/Marker",
  ],
  "INS-TRACK": ["Templates/Editor · Inspector · Track", "System/ScrubField"],
  "INS-APPLIED": ["Templates/Editor · Inspector · Applied edit", "System/Seam"],
  "INS-PENDING": [
    "Templates/Editor · Inspector · Pending edit",
    "System/ScrubField",
  ],
  "INS-EMPTY": ["Templates/Editor · Inspector · Empty"],
  "SCR-LOADING": ["Organisms/LoadingScreen"],
  "SCR-ERROR": ["Organisms/ErrorScreen"],
  "SCR-COVER": ["Organisms/CoverScreen"],
  "CMP-TRANSPORT-PILLS": ["Atoms/Pill"],
  "MENU-PEOPLE": ["Templates/AvatarStack"],
  "CMP-TOOLRAIL": ["Stages/Edit/ToolStrip"],
  "CMP-TABS": ["Stages/Edit/Frame"],
  "CMP-SAVEDOT": ["System/SaveIndicator"],
  "CMP-RULER": ["Templates/TimeRuler", "System/Ruler"],
  "CMP-MARKERS": [
    "Templates/MarkerLane",
    "System/ReadoutChip",
    "System/Marker",
    "System/MarkerLane",
  ],
  "CMP-CLIP": [
    "Templates/ClipBlock",
    "System/ReadoutChip",
    "System/Clip",
    "Stages/Edit/Tracks",
  ],
  "POP-JOIN": ["Templates/JoinPopover", "System/Seam"],
  "OVL-PENDING": ["Templates/PendingEditOverlay"],
  "OVL-APPLIED": ["Templates/AppliedEditOverlay", "System/Seam"],
  "OVL-EDITMARKERS": ["Templates/EditMarkerLayer", "System/Seam"],
  "OVL-STALE": ["Templates/StaleInvalidationOverlay"],
  "OVL-PRESENCE": ["Templates/PresenceOverlay"],
  "OVL-ENVELOPE": ["Templates/EnvelopeOverlay", "System/ReadoutChip"],
  "OVL-BLEED": ["Templates/BleedAttenuationOverlay"],
  "OVL-RANGE": ["Templates/TimelineRange"],
  "OVL-COMMENT-BUBBLE": ["Templates/CommentPlaybackBubble", "System/Marker"],
  "CMP-TRACK-HEADERS": [
    "Templates/TrackHeader",
    "System/ScrubField",
    "System/TrackHeader",
    "Stages/Edit/Tracks",
  ],
  "CMP-TRACK-FADER": ["Templates/TrackFader", "System/ScrubField"],
  "CMP-LEGEND": ["Templates/OverlayLegend"],
  "CMP-TRACK-MIX": ["Templates/TrackMix"],
  "CMP-TURN": ["Templates/TranscriptTurn", "System/ScriptPane"],
  "CMP-GHOST": ["Templates/GhostWordChips"],
  "CMP-EDITBOUNDARY": ["Templates/EditBoundaryMark", "System/Seam"],
  "CMP-REFINE": ["Templates/GuestAttentionBanner"],
  "INS-CLIP": ["Templates/Editor · Inspector · Clip", "System/ScrubField"],
  "INS-ENVELOPE": [
    "Templates/Volume envelope",
    "System/ScrubField",
    "System/ReadoutChip",
  ],
  "INS-BLEED": ["Templates/BleedAttenuationInspector"],
  "SHEET-INSPECTOR": [
    "Organisms/BottomSheet",
    "Stages/Edit/Frame",
    "System/ScrubField",
  ],
  "CMP-SEEK-FOOTER": ["Templates/InspectorSeekFooter"],
  "DLG-EXPORT": ["Templates/ExportDialog"],
  "DLG-BOUNCE": ["Templates/BounceDialog"],
  "DLG-SHARE": ["Templates/ShareDialog"],
  "DLG-MCP": ["Templates/HostMcpDialog"],
  "DLG-SPLIT": ["Stages/Prepare/SplitSpeakers"],
  "DLG-PALETTE": ["Templates/CommandPalette"],
  "DLG-GESTURES": ["Templates/GesturesSheet"],
  "DLG-ASK-CONFIRM": ["Organisms/AskDialog"],
  "DLG-ASK-TEXT": ["Organisms/AskDialog"],
  "CMP-INLINE-CONFIRM": ["Molecules/InlineConfirm"],
  "SHEET-PHONE-MIX": [
    "Stages/Edit/Frame",
    "Templates/TrackMix",
    "System/ScrubField",
  ],
  "SHEET-PHONE-INSPECTOR": ["Stages/Edit/Frame"],
  "SCR-GUEST-LINK-INVALID": ["Organisms/ErrorScreen", "Stages/Review/Guest"],
  "SCR-GUEST-OFFLINE": ["Stages/Edit/Frame", "Templates/GuestAttentionBanner"],
  "BAN-GUEST-ATTENTION": ["Templates/GuestAttentionBanner"],
  "BAN-FOLLOW": ["Templates/FollowBanner"],
  "SCR-REC-LOADING": ["Organisms/LoadingScreen"],
  "SCR-REC-INVALID": ["Organisms/ErrorScreen"],
  "SCR-REC-FULL": ["System/Cover"],
  "SCR-REC-DECLINED": ["Stages/Record/Room"],
  "SCR-REC-LOBBY-GUEST": ["Stages/Record/JoinSheet"],
  "SCR-REC-LOBBY-PRODUCER": ["Stages/Record/JoinSheet"],
  "CMP-REC-DEVICE": ["Stages/Record/JoinSheet"],
  "CMP-REC-CONSENT": ["Stages/Record/JoinSheet"],
  "SCR-REC-ROOM-GUEST": ["Stages/Record/Room"],
  "SCR-REC-ROOM-PRODUCER": ["Stages/Record/Room"],
  "CMP-REC-INDICATOR": ["System/RoomStatusPill"],
  "CMP-REC-ROSTER": ["Stages/Record/PersonTile", "Molecules/ParticipantMeter"],
  "CMP-REC-LIVECOMMENTS": ["Stages/Record/NotesRail"],
  "CMP-REC-UPLOAD": ["Templates/UploadStatus"],
  "CMP-REC-CLIPPING": ["Stages/Record/PersonTile"],
  "EMPTY-STATES": ["Atoms/EmptyState"],
  "CMP-INLINE-ERROR": ["Atoms/InlineError"],
  "DLG-HELP": ["Templates/HelpDialog"],
  "CMP-TUNNEL": ["Templates/ShareDialog"],
  "SCR-SETUP": ["Templates/Home · Setup wizard", "Stages/Home/SetupCard"],
  "SCR-SETUP-CHECKING": [
    "Templates/Home · Setup wizard",
    "Stages/Home/SetupCard",
  ],
  "SCR-SETUP-DOWNLOAD": [
    "Templates/Home · Setup wizard",
    "Stages/Home/SetupCard",
  ],
  "SCR-HOME": ["Templates/Home", "Stages/Home/Home"],
  "SCR-HOME-NEW": ["Templates/Home"],
  "SCR-HOME-OPEN": ["Templates/Home", "Stages/Home/OpenOther"],
  "SCR-HOME-ERROR": ["Templates/Home", "Stages/Home/OpenOther"],
  "DLG-RECORD": ["Stages/Record/Host"],
  "DLG-MODELS": ["Templates/Models dialog"],
  "DLG-MODEL-GATE": ["Templates/Model gate"],
  "POP-WORD-EDIT": [
    "Templates/Editor · Transcript editors",
    "Stages/Edit/ScriptPane",
  ],
  "POP-SPEAKER": [
    "Templates/Editor · Transcript editors",
    "Stages/Edit/SpeakerPopover",
  ],
  "CMP-WORDBAR": ["Templates/Editor · Inspector · Word", "System/ScrubField"],
  "CMP-WORDRANGE": [
    "Templates/Editor · Inspector · Range",
    "System/SelectionHandles",
    "Stages/Edit/ScriptPane",
  ],
  "CMP-RANGE-ACTIONS": [
    "Templates/Editor · Inspector · Range",
    "System/ActionBar",
    "System/ScrubField",
  ],
  "CMP-VOCAB": ["Stages/Prepare/Vocabulary"],
  "DLG-WHISPER": ["Stages/Prepare/ReadyList"],
  "SCR-SHELL-DESKTOP": ["Stages/Edit/Frame"],
  "SCR-SHELL-TABLET": ["Stages/Edit/Frame"],
  "SCR-SHELL-LOADING": ["Stages/Edit/Frame"],
  "SCR-SHELL-INGEST": ["Stages/Edit/Frame", "Stages/Prepare/Prepare"],
  "SCR-GUEST-VIEWER": ["Stages/Edit/Frame", "Stages/Review/Guest"],
  "SCR-GUEST-COMMENTER": [
    "Stages/Edit/Frame",
    "System/ScriptPane",
    "Stages/Review/Guest",
  ],
  "SCR-GUEST-EDITOR": ["Stages/Edit/Frame", "Stages/Review/Guest"],
  "SCR-GUEST-MOBILE": ["Stages/Edit/Frame", "Stages/Review/Guest"],
  "SCR-PHONE-TIMELINE": ["Stages/Edit/Frame", "Stages/Edit/Workspace"],
  "SCR-PHONE-TEXT": [
    "Stages/Edit/Frame",
    "Stages/Edit/Workspace",
    "System/ScriptPane",
  ],
  "OVL-PROSODY": ["Templates/ProsodyOverlay"],
  "OVL-RECORDING": ["Templates/RecordingOverlay"],
  "MENU-CREATE": ["Templates/CreateMenu"],
  "POP-CHOOSER": ["Templates/TargetChooser"],
  "CMP-SOLO-CHIP": ["Templates/SoloChip"],
  "BAN-HOME-SCREEN-HINT": ["Templates/HomeScreenHint", "Stages/Home/Home"],
  "BAN-GUEST-ROLE": ["Stages/Edit/Frame"],
  "BAN-GUEST-VERSION": ["Templates/GuestVersionNotice"],
  "SCR-REC-ACCESS-ENDED": ["System/Cover"],
  "BAN-LOADFAIL": ["Templates/LoadFailureBanner"],
  "MENU-VIEW": ["Templates/OverlayLegend"],
  "CMP-TIMELINE": ["Templates/TimelineRange", "Templates/Timeline"],
  "CMP-REC-NOTICES": ["Stages/Record/RoomAlert", "Templates/Record · Notices"],
  "TOAST-MAIN": ["Molecules/Toast", "Templates/Toast dock"],
  "CMP-GUEST-COMMENT": ["Templates/CommentCompose", "Templates/GuestNameStep"],
};

/** Listed in the inventory but with nothing to draw. */
const NOT_A_SURFACE: Record<string, string> = {
  "INS-CLIP-MULTI":
    "The app has no multi-clip inspector; the Clip inspector takes one clip.",
  "STAT-LIVE": "A screen-reader-only live region with nothing visible.",
  "CMP-DESKTOP-GUARD":
    "A window close guard in the desktop wrapper, not React.",
};

/** Server-rendered HTML outside the React app. */
const OUTSIDE_APP = ["SCR-RECOVERY"];

const storyModules = import.meta.glob(
  ["../**/*.stories.ts", "../**/*.stories.tsx"],
  {
    eager: true,
    import: "default",
  },
) as Record<string, { title?: string }>;
const titles = new Set(Object.values(storyModules).map((meta) => meta.title));

describe("story coverage manifest", () => {
  const ids = [
    ...Object.keys(COVERED),
    ...Object.keys(NOT_A_SURFACE),
    ...OUTSIDE_APP,
  ];

  it("lists each surface once", () => {
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it("lists exactly the surfaces in the inventory", () => {
    expect(INVENTORY_IDS).toHaveLength(135);
    expect(ids.filter((id) => !INVENTORY_IDS.includes(id))).toEqual([]);
    expect(INVENTORY_IDS.filter((id) => !ids.includes(id))).toEqual([]);
  });

  it("finds the story files", () => {
    expect(titles.size).toBeGreaterThan(0);
  });

  it.each(Object.entries(COVERED))(
    "%s names stories that exist",
    (_id, storyTitles) => {
      expect(storyTitles).not.toHaveLength(0);
      expect(storyTitles.filter((title) => !titles.has(title))).toEqual([]);
    },
  );

  it("gives every not-a-surface row a reason", () => {
    expect(
      Object.entries(NOT_A_SURFACE).filter(([, reason]) => !reason.trim()),
    ).toEqual([]);
  });
});
