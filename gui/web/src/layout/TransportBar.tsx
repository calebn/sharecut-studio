import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { capabilityLabel, capabilityTooltip } from "../capabilities/copy";
import { execute } from "../commands/execute";
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
import { RecordTransportChip } from "../record/RecordTransportChip";
import {
  canIngestMedia,
  canManageProjects,
  canRefreshMix,
  guestHearsMixOnly,
} from "../shareMode";
import { useDaw } from "../state/useDaw";
import {
  CommandButton,
  CommandMenuItem,
  Icon,
  Menu,
  MenuSection,
  type MenuTriggerProps,
  Pill,
  pillClassName,
  SegmentedControl,
  ToggleButton,
} from "../ui";
import { audioErrorLabel } from "../utils/audioErrorLabel";
import { AUDITION_MODES, GUESTS_HEAR_FULL_MIX } from "../utils/auditionModes";
import { AvatarStack } from "./AvatarStack";
import { commentModeTitle } from "./commentModeTitle";
import { LayoutRestoreChip, LayoutToggle } from "./LayoutControls";
import { LAYOUT_MODES } from "./layoutModes";
import { OverlayLegend } from "./OverlayLegend";
import { LegendCheckbox } from "./OverlayLegendView";
import { ToolModeToggle } from "./ToolModeToggle";
import { TransportFrame, TransportZone } from "./TransportFrame";
import { TransportPlayControls } from "./TransportPlayControls";
import { TransportTimecode } from "./TransportTimecode";
import { transportPlayHandlers } from "./transportPlay";
import { WaveformViewSections } from "./WaveformViewSections";

/** Transport collapses labeled chrome when shell is tablet/phone or bar width ≤ this. */
export const TRANSPORT_COLLAPSE_PX = 720;

type Props = {
  /** Tablet/phone: start collapsed (also forced by ResizeObserver). */
  compact?: boolean;
  /** Show Fit as a primary icon; false on phone Listen mode. */
  showFit?: boolean;
  /** Phone shell places recording status above the mode body. */
  showRecordingChip?: boolean;
  /** Desktop/tablet: layout toggle, restore chip, View › Layout radios. */
  showLayout?: boolean;
};

export function TransportBar({
  compact = false,
  showFit = true,
  showRecordingChip = true,
  showLayout = false,
}: Props) {
  const {
    project,
    isPlaying,
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
  const { preference, setPreference } = useTheme();
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

  const premixCue = highlightStaleRender && Boolean(breakdown?.premixBehind);
  const guestMixOnly = guestHearsMixOnly(guestMode);
  const auditionGroup = (menu = false) => (
    <SegmentedControl
      className="audition-modes"
      role={menu ? "none" : "group"}
      label="Audition mode"
    >
      {AUDITION_MODES.map((m) => (
        <ToggleButton
          key={m.id}
          quiet
          disabled={loading || (guestMixOnly && m.id !== "mix")}
          pressed={auditionMode === m.id}
          className={m.id === "mix" && premixCue ? "stale-highlight" : ""}
          title={
            guestMixOnly && m.id !== "mix"
              ? `${m.title} (${GUESTS_HEAR_FULL_MIX})`
              : m.title
          }
          aria-description={
            guestMixOnly && m.id !== "mix" ? GUESTS_HEAR_FULL_MIX : undefined
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
  // The wide-bar pill reads just "Mix out of date" so the transport fits at
  // 1280px; the refresh verb lives in its title, name, Mod+B and the
  // collapsed Menu item. Name starts with the visible text (WCAG 2.5.3).
  const staleAria = renderPreviewBusy
    ? "Refreshing mix preview"
    : mayRefresh
      ? `Mix out of date. ${breakdown?.summary ?? ""}. Refresh mix.`
      : `Mix out of date. ${breakdown?.summary ?? ""}`;
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
      >
        {content}
      </button>
    );

  const viewSections = (close: () => void) => (
    <>
      <MenuSection label="Layers">
        <OverlayLegend menu />
      </MenuSection>
      <WaveformViewSections />
      <MenuSection label="Zoom">
        <div className="transport-controls" role="none">
          <CommandMenuItem commandId="view.zoomOut" showShortcut={false}>
            Zoom −
          </CommandMenuItem>
          <CommandMenuItem commandId="view.zoomIn" showShortcut={false}>
            Zoom +
          </CommandMenuItem>
        </div>
        <div className="transport-controls" role="none">
          <CommandMenuItem
            commandId="view.trackHeightDecrease"
            showShortcut={false}
          >
            Track height −
          </CommandMenuItem>
          <CommandMenuItem
            commandId="view.trackHeightIncrease"
            showShortcut={false}
          >
            Track height +
          </CommandMenuItem>
        </div>
        <div className="overlay-legend" role="none">
          <LegendCheckbox
            menu
            checked={fitTracks}
            onChange={() =>
              void execute("view.fitTracksHeight", {}, { skipWhen: true })
            }
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
      {showLayout ? (
        <MenuSection label="Layout">
          <SegmentedControl role="none" className="layout-modes">
            {LAYOUT_MODES.map((m) => (
              <ToggleButton
                key={m.id}
                quiet
                role="menuitemradio"
                pressed={layoutMode === m.id}
                aria-checked={layoutMode === m.id}
                title={titleWithShortcut(m.menuLabel, m.command)}
                aria-keyshortcuts={ariaKeyShortcutsFor(m.command)}
                onClick={() => {
                  close();
                  void execute(m.command, {}, { skipWhen: true });
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
            {renderPreviewBusy ? "Refreshing…" : "Mix out of date"}
          </CommandButton>
        ) : null}
        {!collapsed && !stale ? <Pill tone="ok">Mix up to date</Pill> : null}
        {/* Like the stale pill, status moves into the Menu when collapsed
            (Mix status), where touch users can read the full message. */}
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
                  className="ui-control--compact transport-icon-btn"
                  title={titleWithShortcut("Cut at playhead", "edit.bladeCut")}
                  aria-label="Cut at playhead"
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
              aria-label="Comment"
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
                : mayManage
                  ? "Project, media, markers, and help"
                  : mayIngest
                    ? "Media and help"
                    : "Help",
              <Icon name="menu" />,
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
                  Export deliverables…
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
            {mayManage ? (
              <MenuSection label="Markers">
                <CommandMenuItem
                  commandId="edit.addChapter"
                  respectWhen
                  onSelect={closeMenu}
                >
                  Add chapter at playhead
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
              <MenuSection label="Mix status">
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
                    {renderPreviewBusy
                      ? "Refreshing…"
                      : "Mix out of date · Refresh"}
                  </CommandMenuItem>
                ) : (
                  <p className="transport-menu-note">
                    {stale ? "Mix out of date" : "Mix up to date"}
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
                  Export diagnostics…
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
