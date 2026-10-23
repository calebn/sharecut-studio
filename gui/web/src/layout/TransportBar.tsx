import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { capabilityLabel, capabilityTooltip } from "../capabilities/copy";
import { commandLabel } from "../commands/labels";
import { runPointerCommand } from "../commands/pointer";
import { FEATURE_SHARE_UI_MENU } from "../extensions/features";
import { Slot } from "../extensions/Slot";
import { useStaleRenderBreakdown } from "../hooks/useStaleRenderBreakdown";
import { THEME_OPTIONS, useTheme } from "../hooks/useTheme";
import {
  ariaKeyShortcutsFor,
  displayShortcutFor,
  titleWithShortcut,
} from "../keymap/registry";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import {
  isRecordTransportVisible,
  RecordTransportChip,
  useRecordHostStore,
} from "../record";
import {
  canIngestMedia,
  canManageProjects,
  canRefreshMix,
  canSuggestStructuralOnProject,
  guestHearsMixOnly,
} from "../shareMode";
import { transportAvailability } from "../state/transportAvailability";
import { useDaw } from "../state/useDaw";
import type { AuditionMode } from "../types/session";
import {
  CommandButton,
  CommandMenuItem,
  Icon,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  type MenuTriggerProps,
  Pill,
  pillClassName,
  SegmentedControl,
  ToggleButton,
  useResizeObserver,
} from "../ui";
import {
  audioErrorLabel,
  NO_PREVIEW_ERROR,
  noPreviewReason,
} from "../utils/audioErrorLabel";
import { AUDITION_MODES, GUESTS_HEAR_FULL_MIX } from "../utils/auditionModes";
import { joinSentences } from "../utils/format";
import {
  MIX_CHECKING_LABEL,
  MIX_FRESH_LABEL,
  staleMixLabel,
} from "../utils/staleRender";
import { AvatarStack } from "./AvatarStack";
import { commentModeTitle } from "./commentModeTitle";
import { HistoryControls } from "./HistoryControls";
import { LayoutRestoreChip, LayoutToggle } from "./LayoutControls";
import { LAYOUT_MODES, layoutModeCopy } from "./layoutModes";
import { OverlayLegend } from "./OverlayLegend";
import { LegendCheckbox } from "./OverlayLegendView";
import { ToolModeToggle } from "./ToolModeToggle";
import { TransportFrame, TransportZone } from "./TransportFrame";
import { TransportPlayControls } from "./TransportPlayControls";
import { TransportTimecode } from "./TransportTimecode";
import { transportMenuTitle } from "./transportMenuTitle";
import { transportPlayHandlers } from "./transportPlay";
import { useHistoryControls } from "./useHistoryControls";
import { useZoomControls } from "./useZoomControls";
import { WaveformViewSections } from "./WaveformViewSections";
import { ZoomControls } from "./ZoomControls";

/** Transport collapses labeled chrome when shell is tablet/phone or bar width ≤ this. */
export const TRANSPORT_COLLAPSE_PX = 1240;

const isNarrowTransport = (widthPx: number, hasBladeCut: boolean) =>
  widthPx <= TRANSPORT_COLLAPSE_PX + (hasBladeCut ? 44 : 0);

type Props = {
  /** Tablet/phone: start collapsed (also forced by ResizeObserver). */
  compact?: boolean;
  /** Show Fit as a primary icon; false on phone Listen mode. */
  showFit?: boolean;
  /** Phone shell places recording status above the mode body. */
  showRecordingChip?: boolean;
  /** Desktop/tablet: layout toggle, restore chip, View › Layout radios. */
  showLayout?: boolean;
  /** Phone Listen has no transport bar: render only the Menu trigger. */
  menuOnly?: boolean;
};

export function TransportBar({
  compact = false,
  showFit = true,
  showRecordingChip = true,
  showLayout = false,
  menuOnly = false,
}: Props) {
  const {
    project,
    isPlaying,
    playStartSec,
    auditionMode,
    audioError,
    sessionRegion,
    lastAgentQuery,
    commentMode,
    layoutMode,
    toolMode,
    projectPath,
    guestMode,
    shareCapabilities,
    highlightStaleRender,
    setHighlightStaleRender,
    renderPreviewBusy,
    ingestBusy,
    laneHeightMode,
  } = useDaw((s) => ({
    project: s.project,
    isPlaying: s.isPlaying,
    playStartSec: s.playStartSec,
    auditionMode: s.auditionMode,
    audioError: s.audioError,
    sessionRegion: s.sessionRegion,
    lastAgentQuery: s.lastAgentQuery,
    commentMode: s.commentMode,
    layoutMode: s.layoutMode,
    toolMode: s.toolMode,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    highlightStaleRender: s.highlightStaleRender,
    setHighlightStaleRender: s.setHighlightStaleRender,
    renderPreviewBusy: s.renderPreviewBusy,
    ingestBusy: s.ingestBusy,
    laneHeightMode: s.laneHeightMode,
  }));
  const fitTracks = laneHeightMode === "fit";
  const historyControls = useHistoryControls();
  const zoomControls = useZoomControls();
  const { preference, setPreference } = useTheme();
  const menuErrorId = useId();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [viewOpenState, setViewOpenState] = useState(false);
  const [transportWidth, setTransportWidth] = useState<number | null>(null);
  const narrow =
    transportWidth != null &&
    isNarrowTransport(transportWidth, toolMode === "blade" && !commentMode);
  const headerRef = useRef<HTMLElement>(null);

  // Measured on mount and on a new project, then on every bar resize.
  useEffect(() => {
    const el = headerRef.current;
    if (el) {
      setTransportWidth(el.clientWidth);
    }
  }, [project]);
  useResizeObserver(headerRef, (entries) => {
    const entry = entries[0];
    if (entry) {
      setTransportWidth(entry.contentRect.width);
    }
  });

  const loading = project == null;
  const availability = transportAvailability({
    project,
    isPlaying,
    playStartSec,
  });
  const projectBreakdown = useStaleRenderBreakdown(project);
  const breakdown = project ? projectBreakdown : null;
  const stale = breakdown?.stale ?? false;
  const mayRefresh = canRefreshMix(projectPath, guestMode, shareCapabilities);
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const mayManage = canManageProjects(projectPath);
  const duration = project?.timeline_duration_sec ?? 0;

  // No rendered premix is a fact about Full mix, not a second transport
  // error: the one status pill already says "No mix yet" and carries the fix,
  // so the audio error is dropped rather than squeezing the title (#1113).
  // The Full mix segment keeps the longer reason.
  const noPreview = audioError === NO_PREVIEW_ERROR;
  const noPreviewHint = noPreviewReason(mayRefresh);
  const transportError = noPreview ? null : audioError;
  const recordChipVisible = useRecordHostStore((s) =>
    isRecordTransportVisible(s.snapshot),
  );
  const collapsed =
    compact ||
    narrow ||
    Boolean(
      transportError ||
        sessionRegion ||
        ingestBusy ||
        (showLayout && layoutModeCopy(layoutMode).chipLabel) ||
        (showRecordingChip && recordChipVisible),
    );

  const timelineToolsInMenu = collapsed && !compact && !menuOnly;

  const desktopError =
    !compact && !menuOnly && collapsed ? transportError : null;
  const structuralToolsAllowed = canSuggestStructuralOnProject(
    projectPath,
    guestMode,
    shareCapabilities,
    !loading,
  );

  const premixCue = highlightStaleRender && Boolean(breakdown?.premixBehind);
  const guestMixOnly = guestHearsMixOnly(guestMode);
  const auditionHint = (id: AuditionMode) => {
    if (id === "mix") {
      return noPreview ? noPreviewHint : undefined;
    }
    return guestMixOnly ? GUESTS_HEAR_FULL_MIX : undefined;
  };
  const auditionGroup = (menu = false) => (
    <SegmentedControl
      className="audition-modes"
      role={menu ? "none" : "group"}
      label="Audition mode"
    >
      {AUDITION_MODES.map((m) => {
        const hint = auditionHint(m.id);
        return (
          <ToggleButton
            key={m.id}
            quiet
            disabledReason={
              loading
                ? "Open a project to choose what you hear."
                : guestMixOnly && m.id !== "mix"
                  ? GUESTS_HEAR_FULL_MIX
                  : undefined
            }
            pressed={auditionMode === m.id}
            className={m.id === "mix" && premixCue ? "stale-highlight" : ""}
            title={hint ? `${m.title} (${hint})` : m.title}
            aria-description={hint}
            {...presenceAnchorProps(presenceAnchor("audition", m.id))}
            role={menu ? "menuitemradio" : undefined}
            onClick={() =>
              runPointerCommand("transport.audition", { mode: m.id })
            }
          >
            {m.label}
          </ToggleButton>
        );
      })}
    </SegmentedControl>
  );

  // The host's mix rebuilds on its own (useAutoRefreshMix); the command stays as "update now".
  const autoMix = mayRefresh && mayManage;
  const refreshShortcut = displayShortcutFor("render.refreshMix") ?? "the Menu";
  const refreshHint = !mayRefresh
    ? null
    : autoMix
      ? `Updates on its own. ${refreshShortcut} updates it now.`
      : `Click or ${refreshShortcut} to refresh mix.`;
  const refreshBusyLabel = autoMix ? "Updating mix…" : "Refreshing…";
  const staleTitle = joinSentences([breakdown?.summary, refreshHint]);
  const mixLabel = loading
    ? MIX_CHECKING_LABEL
    : breakdown?.stale
      ? staleMixLabel(breakdown)
      : MIX_FRESH_LABEL;
  const mixPillText =
    mayRefresh && !autoMix ? `${mixLabel} · Refresh` : mixLabel;
  const staleAria = renderPreviewBusy
    ? autoMix
      ? "Updating mix"
      : "Refreshing mix preview"
    : `${joinSentences([mixLabel, breakdown?.detail, mayRefresh ? (autoMix ? "Updates on its own" : "Refresh mix") : null])}.`;
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
    (label: string, title: string, content: ReactNode) =>
    (t: MenuTriggerProps) => (
      <button
        type="button"
        className="ui-control ui-control--compact transport-icon-btn transport-more-btn"
        {...t}
        aria-label={label}
        title={title}
        aria-describedby={
          label === "Menu" && desktopError ? menuErrorId : undefined
        }
      >
        {content}
        {label === "Menu" && desktopError ? (
          <span id={menuErrorId} className="sr-only">
            {desktopError}
          </span>
        ) : null}
      </button>
    );

  const viewSections = (close: () => void) => (
    <>
      {!menuOnly ? (
        <>
          <MenuSection label="Layers">
            <OverlayLegend menu />
          </MenuSection>
          <WaveformViewSections />
          <MenuSection label="Zoom">
            <div className="transport-controls" role="none">
              <CommandMenuItem commandId="view.zoomOut" showShortcut={false} />
              <CommandMenuItem commandId="view.zoomIn" showShortcut={false} />
            </div>
            <div className="transport-controls" role="none">
              <CommandMenuItem
                commandId="view.trackHeightDecrease"
                showShortcut={false}
                short
              />
              <CommandMenuItem
                commandId="view.trackHeightIncrease"
                showShortcut={false}
                short
              />
            </div>
            <div className="overlay-legend" role="none">
              <LegendCheckbox
                menu
                checked={fitTracks}
                onChange={() => runPointerCommand("view.fitTracksHeight")}
              >
                {capabilityLabel("daw.view.fitTracksHeight")}
              </LegendCheckbox>
            </div>
            {!showFit ? (
              <CommandMenuItem commandId="view.fit" onSelect={close}>
                {capabilityLabel("daw.view.fit")}
              </CommandMenuItem>
            ) : null}
          </MenuSection>
        </>
      ) : null}
      {showLayout ? (
        <MenuSection label="Layout">
          <SegmentedControl role="none" className="layout-modes">
            {LAYOUT_MODES.map((m) => (
              <ToggleButton
                key={m.id}
                quiet
                role="menuitemradio"
                tabIndex={-1}
                pressed={layoutMode === m.id}
                aria-checked={layoutMode === m.id}
                title={titleWithShortcut(m.menuLabel, m.command)}
                aria-keyshortcuts={ariaKeyShortcutsFor(m.command)}
                onClick={() => {
                  close();
                  runPointerCommand(m.command, {});
                }}
              >
                {m.menuLabel}
              </ToggleButton>
            ))}
          </SegmentedControl>
        </MenuSection>
      ) : null}
      {/* Theme radios keep the menu open to compare themes in place (like the
          audition radios); layout radios close it because they rearrange the
          shell under the menu. */}
      <MenuSection label="Theme">
        <SegmentedControl role="none" className="theme-modes">
          {THEME_OPTIONS.map((t) => (
            <ToggleButton
              key={t.id}
              quiet
              role="menuitemradio"
              tabIndex={-1}
              pressed={preference === t.id}
              aria-checked={preference === t.id}
              onClick={() => setPreference(t.id)}
            >
              {t.label}
            </ToggleButton>
          ))}
        </SegmentedControl>
      </MenuSection>
    </>
  );

  const overflowMenu = (
    <Menu
      open={overflowOpen}
      onOpenChange={setMenuOpen}
      label="Transport menu"
      menuId="transport-overflow-menu"
      className="transport-overflow ui-menu-root"
      trigger={menuTrigger(
        "Menu",
        desktopError
          ? `${audioErrorLabel(desktopError)}. Open Menu for details.`
          : collapsed
            ? "Layers, zoom, theme, and more"
            : transportMenuTitle({ mayManage, mayIngest }),
        desktopError ? (
          <Icon
            name="warning"
            title={audioErrorLabel(desktopError)}
            style={{ color: "var(--color-transport-warning)" }}
          />
        ) : (
          <Icon name="menu" />
        ),
      )}
    >
      {collapsed ? <AvatarStack variant="menu" /> : null}
      {timelineToolsInMenu ? (
        <MenuSection label="Timeline tools">
          <MenuItem
            disabledReason={
              loading ? "Open a project to select audio" : undefined
            }
            title={titleWithShortcut("Select tool", "tool.select")}
            shortcut={displayShortcutFor("tool.select")}
            keyShortcuts={ariaKeyShortcutsFor("tool.select")}
            onSelect={() => {
              closeMenu();
              runPointerCommand("tool.select");
            }}
          >
            {commandLabel("tool.select")}
          </MenuItem>
          <MenuItem
            disabledReason={
              structuralToolsAllowed
                ? undefined
                : "Blade requires permission to suggest edits"
            }
            title={titleWithShortcut("Blade tool", "tool.blade")}
            shortcut={displayShortcutFor("tool.blade")}
            keyShortcuts={ariaKeyShortcutsFor("tool.blade")}
            onSelect={() => {
              closeMenu();
              runPointerCommand("tool.blade");
            }}
          >
            {commandLabel("tool.blade")}
          </MenuItem>
          <CommandMenuItem commandId="range.arm" onSelect={closeMenu} />
          {toolMode === "blade" && !commentMode ? (
            <CommandMenuItem commandId="edit.bladeCut" onSelect={closeMenu} />
          ) : null}
        </MenuSection>
      ) : null}
      {mayManage ? (
        <MenuSection label="Project">
          <CommandMenuItem commandId="project.new" onSelect={closeMenu} />
          <CommandMenuItem commandId="project.open" onSelect={closeMenu} />
          <MenuSeparator />
          <CommandMenuItem
            commandId="export.bounce"
            respectWhen
            onSelect={closeMenu}
          />
          <CommandMenuItem
            commandId="export.deliverables"
            respectWhen
            onSelect={closeMenu}
          />
          <MenuSeparator />
          <Slot id={FEATURE_SHARE_UI_MENU}>
            <CommandMenuItem
              commandId="share.manage"
              respectWhen
              onSelect={closeMenu}
            />
          </Slot>
          <CommandMenuItem
            commandId="record.openPanel"
            respectWhen
            onSelect={closeMenu}
          />
          <CommandMenuItem commandId="mcp.connect" onSelect={closeMenu} />
        </MenuSection>
      ) : null}
      {mayIngest ? (
        <MenuSection label="Media">
          <CommandMenuItem commandId="media.import" onSelect={closeMenu} />
          <CommandMenuItem commandId="track.add" onSelect={closeMenu} />
          {!menuOnly ? (
            <>
              <CommandMenuItem
                commandId="track.remove"
                respectWhen
                onSelect={closeMenu}
              />
              <CommandMenuItem
                commandId="track.moveUp"
                respectWhen
                onSelect={closeMenu}
              />
              <CommandMenuItem
                commandId="track.moveDown"
                respectWhen
                onSelect={closeMenu}
              />
            </>
          ) : null}
        </MenuSection>
      ) : null}
      {mayManage ? (
        <MenuSection label="Markers">
          <CommandMenuItem
            commandId="edit.addChapter"
            respectWhen
            onSelect={closeMenu}
          />
        </MenuSection>
      ) : null}
      {timelineToolsInMenu || menuOnly ? null : (
        <MenuSection label="Selection">
          <CommandMenuItem commandId="range.arm" onSelect={closeMenu} />
        </MenuSection>
      )}
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
        <MenuSection label="Mix status">
          {noPreview ? (
            <p className="transport-menu-note audio-error-note">
              {noPreviewHint}
            </p>
          ) : null}
          {transportError ? (
            <p className="transport-menu-note audio-error-note">
              {audioErrorLabel(transportError)}: {transportError}
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
              {renderPreviewBusy ? refreshBusyLabel : mixPillText}
            </CommandMenuItem>
          ) : (
            <p className="transport-menu-note">{mixLabel}</p>
          )}
        </MenuSection>
      ) : null}
      {collapsed ? viewSections(closeMenu) : null}
      <MenuSection label="Help">
        {mayManage ? (
          <CommandMenuItem
            commandId="help.diagnosticsBundle"
            onSelect={closeMenu}
          />
        ) : null}
        <CommandMenuItem
          commandId="ui.toggleCommandPalette"
          title="Commands and shortcuts (?)"
          onSelect={closeMenu}
        />
      </MenuSection>
    </Menu>
  );

  if (menuOnly) {
    return overflowMenu;
  }

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
        <TransportPlayControls
          playing={isPlaying}
          availability={availability}
          {...transportPlayHandlers}
        />
        {showRecordingChip ? <RecordTransportChip /> : null}
        <TransportTimecode durationSec={duration} showTotal={!collapsed} />
        {!collapsed ? auditionGroup() : null}
      </TransportZone>
      <TransportZone position="end">
        {ingestBusy ? (
          <Pill tone="warning" title="Importing audio…">
            {collapsed ? "…" : "Importing…"}
          </Pill>
        ) : null}
        {showLayout ? <LayoutRestoreChip collapsed={collapsed} /> : null}
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
            {renderPreviewBusy ? refreshBusyLabel : mixPillText}
          </CommandButton>
        ) : null}
        {!collapsed && loading ? <Pill>{MIX_CHECKING_LABEL}</Pill> : null}
        {!collapsed && !loading && !stale ? (
          <Pill tone="ok">{MIX_FRESH_LABEL}</Pill>
        ) : null}
        {/* Like the stale pill, status moves into the Menu when collapsed
            (Mix status), where touch users can read the full message. */}
        {!collapsed && transportError && (
          <Pill tone="warning" className="audio-error" title={transportError}>
            <span aria-hidden="true">{audioErrorLabel(transportError)}</span>
            <span className="sr-only">{transportError}</span>
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
          {!compact ? (
            <div className="transport-edit-controls">
              <HistoryControls {...historyControls} variant="compact" />
              <ZoomControls {...zoomControls} />
            </div>
          ) : null}
          {!collapsed ? (
            <>
              <ToolModeToggle />
              {toolMode === "blade" && !commentMode ? (
                <CommandButton
                  bare
                  commandId="edit.bladeCut"
                  className="ui-control--compact transport-icon-btn"
                  title={titleWithShortcut(
                    commandLabel("edit.bladeCut"),
                    "edit.bladeCut",
                  )}
                  aria-label={commandLabel("edit.bladeCut")}
                  aria-keyshortcuts={ariaKeyShortcutsFor("edit.bladeCut")}
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
              title={commentModeTitle}
              aria-label={commandLabel("review.toggleCommentMode")}
              aria-keyshortcuts={ariaKeyShortcutsFor(
                "review.toggleCommentMode",
              )}
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
              title={titleWithShortcut(
                capabilityTooltip("daw.view.fit"),
                "view.fit",
              )}
              aria-label={capabilityLabel("daw.view.fit")}
              aria-keyshortcuts={ariaKeyShortcutsFor("view.fit")}
            >
              <Icon name="fit" />
            </CommandButton>
          ) : null}
          {showFit && !collapsed ? (
            <CommandButton
              bare
              commandId="view.fitTracksHeight"
              className="ui-control--compact transport-icon-btn fit-btn"
              title={capabilityTooltip("daw.view.fitTracksHeight", {
                pressed: fitTracks,
              })}
              aria-label={capabilityLabel("daw.view.fitTracksHeight")}
              aria-pressed={fitTracks}
            >
              <Icon name="fitHeight" />
            </CommandButton>
          ) : null}
          {showLayout ? <LayoutToggle /> : null}
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
                "Layers, zoom, track height, layout, and theme",
                "View",
              )}
            >
              {viewSections(closeView)}
            </Menu>
          ) : null}
          {overflowMenu}
        </div>
      </TransportZone>
    </TransportFrame>
  );
}
