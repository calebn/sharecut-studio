import { useCallback, useEffect, useRef, useState } from "react";
import { execute } from "../commands/execute";
import { FEATURE_SHARE_UI_MENU } from "../extensions/features";
import { Slot } from "../extensions/Slot";
import { useStaleRenderBreakdown } from "../hooks/useStaleRenderBreakdown";
import { useTheme } from "../hooks/useTheme";
import { displayShortcutFor } from "../keymap/registry";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { RecordTransportChip } from "../record/RecordTransportChip";
import {
  canIngestMedia,
  canManageProjects,
  canRefreshMix,
  guestHearsMixOnly,
} from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { AuditionMode } from "../types/session";
import {
  CommandButton,
  CommandMenuItem,
  Icon,
  type IconName,
  Menu,
  MenuItem,
  MenuSection,
  type MenuTriggerProps,
  Pill,
  pillClassName,
  SegmentedControl,
  Timecode,
  ToggleButton,
} from "../ui";
import { audioErrorLabel } from "../utils/audioErrorLabel";
import { transportTimecode } from "../utils/time";
import { AvatarStack } from "./AvatarStack";
import { OverlayLegend } from "./OverlayLegend";
import { ToolModeToggle } from "./ToolModeToggle";
import { TransportFrame, TransportZone } from "./TransportFrame";
import { TransportPlayControls } from "./TransportPlayControls";
import { transportPlayHandlers } from "./transportPlay";

const MODES: { id: AuditionMode; label: string; title: string }[] = [
  { id: "mix", label: "Mix", title: "Full premix (all tracks)" },
  { id: "fx", label: "FX", title: "Processed stems (edits + effects)" },
  { id: "raw", label: "Raw", title: "Raw source audio (no FX)" },
];

/** Transport collapses labeled chrome when shell is tablet/phone or bar width ≤ this. */
export const TRANSPORT_COLLAPSE_PX = 720;

type Props = {
  /** Tablet/phone: start collapsed (also forced by ResizeObserver). */
  compact?: boolean;
  /** Show Fit as a primary icon; false on phone Listen mode. */
  showFit?: boolean;
  /** Phone shell places recording status above the mode body. */
  showRecordingChip?: boolean;
};

export function TransportBar({
  compact = false,
  showFit = true,
  showRecordingChip = true,
}: Props) {
  const {
    project,
    playheadSec,
    isPlaying,
    auditionMode,
    audioError,
    sessionRegion,
    lastAgentQuery,
    commentMode,
    focusMode,
    toolMode,
    projectPath,
    guestMode,
    shareCapabilities,
    highlightStaleRender,
    setHighlightStaleRender,
    renderPreviewBusy,
    ingestBusy,
  } = useDaw();
  const { preference, cyclePreference } = useTheme();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [viewOpenState, setViewOpenState] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) {
      return;
    }
    const apply = (width: number) => {
      setNarrow(width <= TRANSPORT_COLLAPSE_PX);
    };
    apply(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        apply(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [project]);

  const collapsed = compact || narrow;
  const loading = project == null;
  const emptyProject = (project?.tracks.length ?? 0) === 0;
  const projectBreakdown = useStaleRenderBreakdown(project);
  const breakdown = project ? projectBreakdown : null;
  const stale = breakdown?.stale ?? false;
  const mayRefresh = canRefreshMix(projectPath, guestMode, shareCapabilities);
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const mayManage = canManageProjects(projectPath);
  const duration = project?.timeline_duration_sec ?? 0;
  const timecode = transportTimecode(playheadSec, duration);

  const themeLabel =
    preference === "system"
      ? "Theme: System"
      : preference === "dark"
        ? "Theme: Dark"
        : "Theme: Light";

  const focusLabel =
    focusMode === "default"
      ? "Focus: Default"
      : focusMode === "timeline"
        ? "Focus: Timeline"
        : focusMode === "text"
          ? "Focus: Text"
          : "Focus: Review";

  const premixCue = highlightStaleRender && Boolean(breakdown?.premixBehind);
  const guestMixOnly = guestHearsMixOnly(guestMode);
  const auditionGroup = (menu = false) => (
    <SegmentedControl
      className="audition-modes"
      role={menu ? "none" : "group"}
      label="Audition mode"
    >
      {MODES.map((m) => (
        <ToggleButton
          key={m.id}
          quiet
          disabled={loading || (guestMixOnly && m.id !== "mix")}
          pressed={auditionMode === m.id}
          className={m.id === "mix" && premixCue ? "stale-highlight" : ""}
          title={
            guestMixOnly && m.id !== "mix"
              ? `${m.title} (guests listen in Mix)`
              : m.title
          }
          aria-description={
            guestMixOnly && m.id !== "mix" ? "Guests listen in Mix" : undefined
          }
          {...presenceAnchorProps(presenceAnchor("audition", m.id))}
          role={menu ? "menuitemradio" : undefined}
          onClick={() =>
            void execute(
              "transport.audition",
              { mode: m.id },
              { skipWhen: true },
            )
          }
        >
          {m.label}
        </ToggleButton>
      ))}
    </SegmentedControl>
  );

  const staleTitle = mayRefresh
    ? `${breakdown?.summary ?? ""}. Click or ${displayShortcutFor("render.refreshMix") ?? "use the Menu"} to refresh mix.`
    : (breakdown?.summary ?? "");
  const staleAria = renderPreviewBusy
    ? "Refreshing mix preview"
    : mayRefresh
      ? `Stale render. ${breakdown?.summary ?? ""}. Refresh mix.`
      : `Stale render. ${breakdown?.summary ?? ""}`;
  const setStaleHighlight = (on: boolean) => {
    setHighlightStaleRender(on);
  };

  // The two transport menus are exclusive: each Menu listens on window, so
  // two open panels would fight over arrow keys and Escape.
  const setMenuOpen = useCallback(
    (open: boolean) => {
      setOverflowOpen(open);
      if (open) {
        setViewOpenState(false);
      } else {
        setHighlightStaleRender(false);
      }
    },
    [setHighlightStaleRender],
  );
  const closeMenu = () => setMenuOpen(false);
  const setViewOpen = (open: boolean) => {
    setViewOpenState(open);
    if (open) {
      setMenuOpen(false);
    }
  };
  const closeView = () => setViewOpen(false);
  // The View menu only exists in the wide bar; collapsing closes it, so it
  // never remounts already open when the bar widens again.
  if (collapsed && viewOpenState) {
    setViewOpenState(false);
  }
  const viewOpen = viewOpenState && !collapsed;

  const menuTrigger =
    (label: string, title: string, icon: IconName) => (t: MenuTriggerProps) => (
      <button
        type="button"
        className="ui-control ui-control--compact transport-icon-btn transport-more-btn"
        {...t}
        aria-label={label}
        title={title}
      >
        <Icon name={icon} />
      </button>
    );

  const viewSections = (close: () => void) => (
    <>
      <MenuSection label="Layers">
        <OverlayLegend menu />
      </MenuSection>
      <MenuSection label="View">
        <div className="transport-controls" role="none">
          <CommandMenuItem commandId="view.zoomOut" showShortcut={false}>
            Zoom −
          </CommandMenuItem>
          <CommandMenuItem commandId="view.zoomIn" showShortcut={false}>
            Zoom +
          </CommandMenuItem>
        </div>
        {!showFit ? (
          <CommandMenuItem commandId="view.fit" onSelect={close}>
            Fit to window
          </CommandMenuItem>
        ) : null}
        <MenuItem
          className="theme-toggle-btn"
          title={themeLabel}
          onSelect={() => cyclePreference()}
        >
          {themeLabel}
        </MenuItem>
        {!compact ? (
          <CommandMenuItem commandId="focus.cycle">
            {focusLabel}
          </CommandMenuItem>
        ) : null}
      </MenuSection>
    </>
  );

  return (
    <TransportFrame
      ref={headerRef}
      compact={compact}
      collapsed={collapsed}
      playing={isPlaying}
    >
      <TransportZone position="start">
        <h1>{project?.meta.name ?? "Loading episode…"}</h1>
      </TransportZone>
      <TransportZone position="center">
        <div className="transport-play">
          <TransportPlayControls
            playing={isPlaying}
            disabled={!project || emptyProject}
            disabledTitle={emptyProject ? "Import audio to play" : undefined}
            {...transportPlayHandlers}
          />
        </div>
        {showRecordingChip ? <RecordTransportChip /> : null}
        <Timecode
          current={timecode.current}
          total={collapsed ? undefined : timecode.total}
          title={timecode.title}
        />
        {!collapsed ? auditionGroup() : null}
      </TransportZone>
      <TransportZone position="end">
        {ingestBusy ? (
          <Pill tone="warning" title="Importing audio…">
            {collapsed ? "…" : "Importing…"}
          </Pill>
        ) : null}
        {!collapsed && stale ? (
          <CommandButton
            bare
            commandId="render.refreshMix"
            className={pillClassName(
              "warning",
              mayRefresh ? "pill--action" : "pill--info",
              renderPreviewBusy && "pill--busy",
            )}
            title={staleTitle}
            aria-label={staleAria}
            aria-busy={renderPreviewBusy || undefined}
            aria-disabled={!mayRefresh || renderPreviewBusy || undefined}
            onPointerEnter={() => setStaleHighlight(true)}
            onPointerLeave={() => setStaleHighlight(false)}
            onFocus={() => setStaleHighlight(true)}
            onBlur={() => setStaleHighlight(false)}
            onClick={(e) => {
              if (!mayRefresh || renderPreviewBusy) {
                e.preventDefault();
              }
            }}
          >
            {renderPreviewBusy ? "Refreshing…" : "Stale render"}
          </CommandButton>
        ) : null}
        {!collapsed && !stale ? <Pill tone="ok">Fresh</Pill> : null}
        {/* Like the stale pill, status moves into the Menu when collapsed
            (Render status), where touch users can read the full message. */}
        {!collapsed && audioError && (
          <Pill tone="warning" className="audio-error" title={audioError}>
            <span aria-hidden="true">{audioErrorLabel(audioError)}</span>
            <span className="sr-only">{audioError}</span>
          </Pill>
        )}
        {!collapsed && sessionRegion ? (
          <Pill
            tone="audition"
            title={`${sessionRegion.start_sec.toFixed(1)}–${sessionRegion.end_sec.toFixed(1)}s`}
          >
            {lastAgentQuery
              ? `Agent: “${lastAgentQuery}”`
              : `Region ${sessionRegion.start_sec.toFixed(1)}–${sessionRegion.end_sec.toFixed(1)}s`}
          </Pill>
        ) : null}

        <div className="transport-primary-actions">
          {!collapsed ? (
            <>
              <ToolModeToggle />
              {toolMode === "blade" && !commentMode ? (
                <CommandButton
                  bare
                  commandId="edit.bladeCut"
                  args={{ atTime: playheadSec }}
                  className="ui-control--compact transport-icon-btn"
                  title="Split selected tracks at playhead"
                  aria-label="Cut at playhead"
                >
                  <Icon name="cutAtPlayhead" />
                </CommandButton>
              ) : null}
            </>
          ) : (
            <CommandButton
              bare
              commandId="review.toggleCommentMode"
              className={`ui-control--compact transport-icon-btn comment-mode-btn${commentMode ? " active" : ""}`}
              title="Comment mode: click/drag ruler to anchor feedback"
              aria-label="Comment"
              aria-pressed={commentMode}
            >
              <Icon name="comment" />
            </CommandButton>
          )}
          {showFit ? (
            <CommandButton
              bare
              commandId="view.fit"
              className="ui-control--compact transport-icon-btn fit-btn"
              title="Fit session in view"
              aria-label="Fit"
            >
              <Icon name="fit" />
            </CommandButton>
          ) : null}
          {!collapsed ? <AvatarStack /> : null}
          {!collapsed ? (
            <Menu
              open={viewOpen}
              onOpenChange={setViewOpen}
              label="View menu"
              menuId="transport-view-menu"
              className="transport-overflow ui-menu-root"
              trigger={menuTrigger(
                "View",
                "Layers, zoom, theme, and focus",
                "layers",
              )}
            >
              {viewSections(closeView)}
            </Menu>
          ) : null}
          <Menu
            open={overflowOpen}
            onOpenChange={setMenuOpen}
            label="Transport menu"
            menuId="transport-overflow-menu"
            className="transport-overflow ui-menu-root"
            trigger={menuTrigger(
              "Menu",
              collapsed
                ? "Layers, zoom, theme, and more"
                : "Project, media, and help",
              "menu",
            )}
          >
            {collapsed ? <AvatarStack variant="menu" /> : null}
            {mayManage ? (
              <MenuSection label="Project">
                <CommandMenuItem commandId="project.new" onSelect={closeMenu}>
                  New project…
                </CommandMenuItem>
                <CommandMenuItem commandId="project.open" onSelect={closeMenu}>
                  Open project…
                </CommandMenuItem>
                <CommandMenuItem commandId="mcp.connect" onSelect={closeMenu}>
                  Connect agent…
                </CommandMenuItem>
                <CommandMenuItem
                  commandId="export.bounce"
                  respectWhen
                  onSelect={closeMenu}
                >
                  Bounce…
                </CommandMenuItem>
                <Slot id={FEATURE_SHARE_UI_MENU}>
                  <CommandMenuItem
                    commandId="share.manage"
                    respectWhen
                    onSelect={closeMenu}
                  >
                    Share…
                  </CommandMenuItem>
                </Slot>
                <CommandMenuItem
                  commandId="record.openPanel"
                  respectWhen
                  onSelect={closeMenu}
                >
                  Record room…
                </CommandMenuItem>
                <CommandMenuItem
                  commandId="export.deliverables"
                  respectWhen
                  onSelect={closeMenu}
                >
                  Export deliverables
                </CommandMenuItem>
              </MenuSection>
            ) : null}
            {mayIngest ? (
              <MenuSection label="Media">
                <CommandMenuItem commandId="media.import" onSelect={closeMenu}>
                  Import audio…
                </CommandMenuItem>
                <CommandMenuItem commandId="track.add" onSelect={closeMenu}>
                  New track
                </CommandMenuItem>
                <CommandMenuItem
                  commandId="track.remove"
                  respectWhen
                  onSelect={closeMenu}
                >
                  Remove track
                </CommandMenuItem>
                <CommandMenuItem
                  commandId="track.moveUp"
                  respectWhen
                  onSelect={closeMenu}
                >
                  Move track up
                </CommandMenuItem>
                <CommandMenuItem
                  commandId="track.moveDown"
                  respectWhen
                  onSelect={closeMenu}
                >
                  Move track down
                </CommandMenuItem>
              </MenuSection>
            ) : null}
            {collapsed ? (
              <MenuSection label="Audition">{auditionGroup(true)}</MenuSection>
            ) : null}
            {collapsed && sessionRegion ? (
              <MenuSection label="Session">
                <p className="transport-menu-note">
                  {lastAgentQuery
                    ? `Agent: “${lastAgentQuery}”`
                    : `Region ${sessionRegion.start_sec.toFixed(1)}–${sessionRegion.end_sec.toFixed(1)}s`}
                </p>
              </MenuSection>
            ) : null}
            {collapsed ? (
              <MenuSection label="Render status">
                {audioError ? (
                  <p className="transport-menu-note audio-error-note">
                    {audioErrorLabel(audioError)}: {audioError}
                  </p>
                ) : null}
                {stale && mayRefresh ? (
                  <CommandMenuItem
                    commandId="render.refreshMix"
                    title={staleTitle}
                    onSelect={closeMenu}
                    respectWhen
                    onPointerEnter={() => setStaleHighlight(true)}
                    onPointerLeave={() => setStaleHighlight(false)}
                    onFocus={() => setStaleHighlight(true)}
                    onBlur={() => setStaleHighlight(false)}
                  >
                    {renderPreviewBusy ? "Refreshing…" : "Refresh mix (stale)"}
                  </CommandMenuItem>
                ) : (
                  <p className="transport-menu-note">
                    Render: {stale ? "Stale" : "Fresh"}
                  </p>
                )}
              </MenuSection>
            ) : null}
            {collapsed ? viewSections(closeMenu) : null}
            <MenuSection label="Help">
              {mayManage ? (
                <CommandMenuItem
                  commandId="help.diagnosticsBundle"
                  onSelect={closeMenu}
                >
                  Help…
                </CommandMenuItem>
              ) : null}
              <CommandMenuItem
                commandId="ui.toggleCommandPalette"
                title="Keyboard shortcuts (?)"
                onSelect={closeMenu}
              >
                Keyboard shortcuts
              </CommandMenuItem>
            </MenuSection>
          </Menu>
        </div>
      </TransportZone>
    </TransportFrame>
  );
}
