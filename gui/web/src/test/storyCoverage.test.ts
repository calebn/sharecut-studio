import { describe, expect, it } from "vitest";

/**
 * Every non-interaction surface in the UI inventory and the story titles that
 * render it. A story title lists every export of that file, so one title can
 * cover several IDs. `PENDING` only shrinks: a surface leaves it in the commit
 * that adds its story.
 */
const COVERED: Record<string, string[]> = {
  "PNL-TRANSCRIPT": [
    "Templates/Editor · Transcript panel",
    "Templates/TranscriptTurn",
  ],
  "CMP-FINDREPLACE": ["Templates/Editor · Transcript panel"],
  "DLG-PRECISION": ["Templates/Editor · Precision boundary dialog"],
  "PNL-COMMENTS": [
    "Templates/Editor · Comments panel",
    "Templates/CommentCard",
    "Templates/CommentCompose",
  ],
  "CMP-GUEST-NAME": ["Templates/Editor · Comments panel"],
  "DLG-STEP-PARAMS": ["Templates/Editor · Pipeline panel"],
  "PNL-PIPELINE": ["Templates/Editor · Pipeline panel"],
  "PNL-TIGHTEN": ["Templates/Editor · Tighten panel"],
  "PNL-IMPACT": ["Templates/Editor · Impact panel"],
  "PNL-HISTORY": ["Templates/Editor · History panel"],
  "INS-PEEK": ["Templates/Editor · Inspector · Peek"],
  "INS-RANGE": ["Templates/Editor · Inspector · Range"],
  "INS-WORD": ["Templates/Editor · Inspector · Word"],
  "INS-COMMENT": ["Templates/Editor · Inspector · Comment"],
  "INS-SOCIAL": ["Templates/Editor · Inspector · Social clip"],
  "INS-CHAPTER": ["Templates/Editor · Inspector · Chapter"],
  "INS-TRACK": ["Templates/Editor · Inspector · Track"],
  "INS-APPLIED": ["Templates/Editor · Inspector · Applied edit"],
  "INS-PENDING": ["Templates/Editor · Inspector · Pending edit"],
  "INS-EMPTY": ["Templates/Editor · Inspector · Empty"],
  "SCR-LOADING": ["Organisms/LoadingScreen"],
  "SCR-ERROR": ["Organisms/ErrorScreen"],
  "SCR-COVER": ["Organisms/CoverScreen"],
  "CMP-TRANSPORT-PILLS": ["Atoms/Pill", "Templates/Transport"],
  "MENU-PEOPLE": ["Templates/AvatarStack"],
  "CMP-TOOLRAIL": ["Templates/EditingToolRail", "Templates/ToolModeToggle"],
  "CMP-SPLITTER": ["Templates/BottomTabsSplitter"],
  "CMP-TABS": ["Templates/StudioShell"],
  "CMP-STATUSBAR": ["Templates/StatusBar"],
  "CMP-SAVEDOT": ["Templates/SaveStateDotView"],
  "CMP-PIPELINE-CHIP": ["Templates/PipelineStatusChip"],
  "CMP-RULER": ["Templates/TimeRuler"],
  "CMP-MARKERS": ["Templates/MarkerLane"],
  "CMP-CLIP": ["Templates/ClipBlock"],
  "POP-JOIN": ["Templates/JoinPopover"],
  "OVL-PENDING": ["Templates/PendingEditOverlay"],
  "OVL-APPLIED": ["Templates/AppliedEditOverlay"],
  "OVL-EDITMARKERS": ["Templates/EditMarkerLayer"],
  "OVL-STALE": ["Templates/StaleInvalidationOverlay"],
  "OVL-PRESENCE": ["Templates/PresenceOverlay"],
  "OVL-ENVELOPE": ["Templates/EnvelopeOverlay"],
  "OVL-BLEED": ["Templates/BleedAttenuationOverlay"],
  "OVL-RANGE": ["Templates/TimelineRange"],
  "OVL-COMMENT-BUBBLE": ["Templates/CommentPlaybackBubble"],
  "CMP-TRACK-HEADERS": ["Templates/TrackHeader"],
  "CMP-TRACK-FADER": ["Templates/TrackFader"],
  "CMP-LEGEND": ["Templates/OverlayLegend"],
  "CMP-TRACK-MIX": ["Templates/TrackMix"],
  "CMP-TURN": ["Templates/TranscriptTurn"],
  "CMP-GHOST": ["Templates/GhostWordChips"],
  "CMP-EDITBOUNDARY": ["Templates/EditBoundaryMark"],
  "CMP-REFINE": ["Templates/GuestAttentionBanner"],
  "INS-CLIP": ["Templates/Editor · Inspector · Clip"],
  "INS-ENVELOPE": ["Templates/Volume envelope"],
  "INS-BLEED": ["Templates/BleedAttenuationInspector"],
  "SHEET-INSPECTOR": ["Organisms/BottomSheet", "Templates/MobileShell"],
  "CMP-SEEK-FOOTER": ["Templates/InspectorSeekFooter"],
  "DLG-EXPORT": ["Templates/ExportDialog"],
  "DLG-BOUNCE": ["Templates/BounceDialog"],
  "DLG-SHARE": ["Templates/ShareDialog"],
  "DLG-MCP": ["Templates/HostMcpDialog"],
  "DLG-SPLIT": ["Templates/SplitSpeakersDialog"],
  "DLG-PALETTE": ["Templates/CommandPalette"],
  "DLG-GESTURES": ["Templates/GesturesSheet"],
  "DLG-ASK-CONFIRM": ["Organisms/AskDialog"],
  "DLG-ASK-TEXT": ["Organisms/AskDialog"],
  "CMP-INLINE-CONFIRM": ["Molecules/InlineConfirm"],
  "SHEET-PHONE-MIX": ["Templates/MobileShell", "Templates/TrackMix"],
  "SHEET-PHONE-INSPECTOR": ["Templates/MobileShell"],
  "SCR-GUEST-LINK-INVALID": ["Organisms/ErrorScreen"],
  "SCR-GUEST-OFFLINE": ["Templates/GuestAttentionBanner"],
  "BAN-GUEST-ATTENTION": ["Templates/GuestAttentionBanner"],
  "BAN-FOLLOW": ["Templates/FollowBanner"],
  "SCR-REC-LOADING": ["Organisms/LoadingScreen"],
  "SCR-REC-INVALID": ["Organisms/ErrorScreen"],
  "SCR-REC-FULL": ["Templates/FullRoom"],
  "SCR-REC-DECLINED": ["Templates/Declined"],
  "SCR-REC-LOBBY-GUEST": ["Templates/Lobby"],
  "SCR-REC-LOBBY-PRODUCER": ["Templates/Lobby"],
  "CMP-REC-DEVICE": ["Templates/DeviceCheck"],
  "CMP-REC-CONSENT": ["Templates/ConsentGate"],
  "CMP-REC-ROOMTONE": ["Templates/RoomToneCapture"],
  "SCR-REC-ROOM-GUEST": ["Templates/Room"],
  "SCR-REC-ROOM-PRODUCER": ["Templates/Room"],
  "CMP-REC-INDICATOR": ["Templates/RecIndicator"],
  "CMP-REC-ROSTER": ["Templates/Roster", "Molecules/ParticipantMeter"],
  "CMP-REC-LIVECOMMENTS": ["Templates/LiveComments"],
  "CMP-REC-UPLOAD": ["Templates/UploadStatus"],
  "CMP-REC-CLIPPING": ["Templates/TakeClippingReport"],
  "CMP-REC-HOSTROSTER": ["Templates/HostUploadRoster"],
  "EMPTY-STATES": ["Atoms/EmptyState"],
  "CMP-INLINE-ERROR": ["Atoms/InlineError"],
  "DLG-HELP": ["Templates/HelpDialog"],
  "CMP-TUNNEL": ["Templates/ShareDialog"],
  "CMP-PRESENCE-STATUS": ["Templates/StatusBar"],
  "SCR-SETUP": ["Templates/Home · Setup wizard"],
  "SCR-SETUP-CHECKING": ["Templates/Home · Setup wizard"],
  "SCR-SETUP-DOWNLOAD": ["Templates/Home · Setup wizard"],
};

/** A story exists but shows only part of the surface. */
const PARTIAL: Record<string, string[]> = {
  "SCR-SHELL-DESKTOP": ["Templates/StudioShell"],
  "SCR-SHELL-TABLET": ["Templates/StudioShell"],
  "SCR-SHELL-LOADING": ["Templates/StudioShell", "Templates/StatusBar"],
  "SCR-SHELL-INGEST": ["Templates/StudioShell"],
  "SCR-LAYOUT-TIMELINE": ["Templates/BottomTabsSplitter"],
  "CMP-TRANSPORT": ["Templates/Transport", "Templates/TransportPlayControls"],
  "MENU-MAIN": ["Molecules/Menu"],
  "MENU-VIEW": ["Templates/OverlayLegend"],
  "CMP-TIMELINE": ["Templates/TimelineRange"],
  "DLG-MODEL-GATE": ["Templates/ExportDialog", "Templates/SplitSpeakersDialog"],
  "SCR-PHONE-LISTEN": ["Templates/ListenHero", "Templates/MobileShell"],
  "SCR-PHONE-TIMELINE": ["Templates/MobileShell"],
  "SCR-PHONE-TEXT": ["Templates/MobileShell"],
  "SCR-PHONE-MORE": ["Templates/MobileShell"],
  "SCR-PHONE-MORE-PANEL": ["Templates/MobileShell"],
  "SCR-GUEST-VIEWER": ["Templates/StudioShell", "Templates/ToolModeToggle"],
  "SCR-GUEST-COMMENTER": ["Templates/StudioShell"],
  "SCR-GUEST-EDITOR": ["Templates/StudioShell"],
  "SCR-GUEST-MOBILE": ["Templates/MobileShell"],
  "CMP-REC-NOTICES": ["Templates/Room"],
  "TOAST-MAIN": ["Molecules/Toast"],
  "CMP-GUEST-COMMENT": ["Templates/CommentCompose"],
};

const PENDING = [
  "SCR-HOME",
  "SCR-HOME-NEW",
  "SCR-HOME-OPEN",
  "SCR-HOME-ERROR",
  "SCR-LAYOUT-TEXT",
  "SCR-LAYOUT-REVIEW",
  "CMP-LAYOUT-CHIP",
  "CMP-DRAWER-HANDLE",
  "OVL-PROSODY",
  "OVL-RECORDING",
  "CMP-RANGE-ACTIONS",
  "MENU-CREATE",
  "POP-CHOOSER",
  "CMP-SOLO-CHIP",
  "POP-WORD-EDIT",
  "POP-SPEAKER",
  "CMP-WORDBAR",
  "CMP-WORDRANGE",
  "CMP-VOCAB",
  "INS-CLIP-MULTI",
  "DLG-MODELS",
  "DLG-WHISPER",
  "DLG-RECORD",
  "BAN-HOME-SCREEN-HINT",
  "BAN-GUEST-ROLE",
  "BAN-GUEST-VERSION",
  "SCR-REC-ACCESS-ENDED",
  "CMP-REC-STOP",
  "CHIP-REC-TRANSPORT",
  "STAT-LIVE",
  "BAN-LOADFAIL",
  "CMP-RAIL-PEEK",
  "CMP-DESKTOP-GUARD",
];

/** Server-rendered HTML outside the React app. */
const OUTSIDE_APP = ["SCR-RECOVERY"];

const PENDING_LIMIT = 33;

const storyModules = import.meta.glob("../**/*.stories.tsx", {
  eager: true,
  import: "default",
}) as Record<string, { title?: string }>;
const titles = new Set(Object.values(storyModules).map((meta) => meta.title));

describe("story coverage manifest", () => {
  it("lists each surface once", () => {
    const ids = [
      ...Object.keys(COVERED),
      ...Object.keys(PARTIAL),
      ...PENDING,
      ...OUTSIDE_APP,
    ];
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it.each([...Object.entries(COVERED), ...Object.entries(PARTIAL)])(
    "%s names stories that exist",
    (_id, storyTitles) => {
      expect(storyTitles.filter((title) => !titles.has(title))).toEqual([]);
    },
  );

  it("does not let pending surfaces grow", () => {
    expect(PENDING.length).toBeLessThanOrEqual(PENDING_LIMIT);
  });
});
