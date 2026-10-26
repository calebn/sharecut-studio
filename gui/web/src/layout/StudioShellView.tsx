import type { DragEventHandler, ReactNode, Ref, RefCallback } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { isHostOnlyTab, studioTabIds } from "../presence/followSync";
import { TAB_LABELS } from "../stage/frame/tabLabels";
import type { EffectiveLayoutMode } from "../state/layoutPresentation";
import type { PresenceTab } from "../types/session";
import { BottomSheet } from "../ui/BottomSheet";
import { INSPECTOR_SHEET_CLASS } from "../ui/compactSheet";
import { Tab, TabList } from "../ui/Tabs";
import {
  INSPECTOR_COLUMN_SHELL_CLASS,
  type SheetPresentation,
  type ShellAppearance,
  type ShellNotices,
} from "./shellPresentation";

const PANEL_TAB_ID = "studio-panel-tab";
const PANEL_TABPANEL_ID = "studio-panel";

export type IngestPresentation = {
  over: boolean;
  dropLabel: string;
  importShortcut: string;
  coachOpen: boolean;
  onDragOver: DragEventHandler<HTMLButtonElement>;
  onDragLeave: DragEventHandler<HTMLButtonElement>;
  onDrop: DragEventHandler<HTMLButtonElement>;
  onImport: () => void;
  onDismissCoach: () => void;
};
export type StudioWorkspace =
  | { kind: "loading"; headers: ReactNode; canvas: ReactNode }
  | { kind: "ingest"; headers: ReactNode; ingest: IngestPresentation }
  | { kind: "arrange"; canvas: ReactNode };
export type StudioShellViewProps = {
  feedbackHostRef?: RefCallback<HTMLDivElement>;
  appearance: ShellAppearance;
  layout: EffectiveLayoutMode;
  chrome: {
    notices: ShellNotices;
    transport: ReactNode;
    footer: ReactNode;
    overlay: ReactNode;
  };
  workspace: StudioWorkspace;
  panels: {
    activeTab: PresenceTab;
    pipelineRunning: boolean;
    splitter: ReactNode;
    /** The grab handle that reopens the drawer in the timeline layout. */
    reopenHandle: ReactNode;
    content: ReactNode;
    onTabChange: (tab: PresenceTab) => void;
  };
  inspector:
    | { kind: "desktop"; content: ReactNode }
    | { kind: "tablet"; tools: ReactNode; sheet: SheetPresentation };
  bindings?: {
    root?: Ref<HTMLDivElement>;
    transport?: Ref<HTMLDivElement>;
    main?: Ref<HTMLElement>;
    panels?: Ref<HTMLElement>;
  };
};

export function StudioShellView({
  feedbackHostRef,
  appearance,
  layout,
  chrome,
  workspace,
  panels,
  inspector,
  bindings,
}: StudioShellViewProps) {
  const inspectorColumn =
    inspector.kind === "tablet" &&
    inspector.sheet.open &&
    inspector.sheet.placement === "column";
  const sheet =
    inspector.kind === "tablet" ? (
      <BottomSheet
        backgroundPolicy="interactive"
        open={inspector.sheet.open}
        onClose={inspector.sheet.onClose}
        title="Inspector"
        placement={inspector.sheet.placement}
        className={inspector.sheet.className ?? INSPECTOR_SHEET_CLASS}
        expanded={inspector.sheet.expanded}
        onExpandedChange={inspector.sheet.onExpandedChange}
        {...inspector.sheet.compact}
        bodyHeader={
          inspector.sheet.compact && !inspector.sheet.compact.stowed ? (
            <div ref={feedbackHostRef} className="compact-feedback-slot" />
          ) : null
        }
      >
        {inspector.sheet.content}
      </BottomSheet>
    ) : null;
  const tabIds = studioTabIds(appearance.guestShare);
  return (
    <div
      ref={bindings?.root}
      className={[
        "daw-shell",
        appearance.guestShare ? "daw-shell-guest" : "",
        !appearance.guestShare ? "daw-shell--attention" : "",
        appearance.following ? "daw-shell--following" : "",
        `daw-shell--${inspector.kind}`,
        layout !== "default" ? `daw-shell--layout-${layout}` : "",
        inspectorColumn ? INSPECTOR_COLUMN_SHELL_CLASS : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-shell={inspector.kind}
    >
      <div className="daw-shell-banners">{chrome.notices.banners}</div>
      {chrome.notices.follow}
      <div ref={bindings?.transport} className="daw-shell-transport">
        {chrome.transport}
      </div>
      <main
        ref={bindings?.main}
        className={[
          "daw-main",
          workspace.kind === "arrange" ? "daw-main--arrange" : "",
          inspector.kind === "desktop" && inspector.content == null
            ? "daw-main--inspector-collapsed"
            : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {workspace.kind === "loading" ? (
          <>
            {workspace.headers}
            {workspace.canvas}
          </>
        ) : workspace.kind === "ingest" ? (
          <>
            {workspace.headers}
            <div className="empty-session-wrap">
              <button
                type="button"
                className={`empty-session-drop${workspace.ingest.over ? " lane-drop-target" : ""}`}
                onDragOver={workspace.ingest.onDragOver}
                onDragLeave={workspace.ingest.onDragLeave}
                onDrop={workspace.ingest.onDrop}
                onClick={() => workspace.ingest.onImport()}
              >
                <span className="empty-session-ghost" aria-hidden="true" />
                <span className="empty-session-drop-label">
                  {workspace.ingest.dropLabel}
                </span>
              </button>
              {workspace.ingest.coachOpen ? (
                <div className="box elevated empty-session-coach" role="status">
                  <p>
                    Drop stems here. Use one file per speaker. One recording of
                    everyone? Import it, then choose Split speakers. Import is
                    also under Menu ({workspace.ingest.importShortcut}).
                  </p>
                  <button
                    type="button"
                    className="empty-session-coach-dismiss"
                    onClick={() => workspace.ingest.onDismissCoach()}
                  >
                    Got it
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          workspace.canvas
        )}
        {inspector.kind === "tablet" ? inspector.tools : inspector.content}
      </main>
      {sheet}
      <section
        ref={bindings?.panels}
        className="bottom-tabs"
        aria-label="Editor panels"
      >
        {layout === "default" ? panels.splitter : null}
        <TabList label="Panel tabs" className="tab-bar">
          {tabIds.map((id) => (
            <Tab
              key={id}
              id={`${PANEL_TAB_ID}-${id}`}
              panelId={PANEL_TABPANEL_ID}
              selected={panels.activeTab === id}
              tabStop={
                id ===
                (tabIds.includes(panels.activeTab)
                  ? panels.activeTab
                  : tabIds[0])
              }
              {...presenceAnchorProps(presenceAnchor("tab", id))}
              onClick={() => panels.onTabChange(id)}
            >
              {TAB_LABELS[id]}
              {id === "pipeline" && panels.pipelineRunning ? " ●" : ""}
            </Tab>
          ))}
        </TabList>
        <div
          className="tab-content"
          role="tabpanel"
          id={PANEL_TABPANEL_ID}
          aria-labelledby={
            tabIds.includes(panels.activeTab)
              ? `${PANEL_TAB_ID}-${panels.activeTab}`
              : undefined
          }
          aria-label={
            tabIds.includes(panels.activeTab) ? undefined : "Editor panel"
          }
        >
          {!appearance.guestShare || !isHostOnlyTab(panels.activeTab)
            ? panels.content
            : null}
        </div>
      </section>
      {layout === "timeline" &&
      !(inspector.kind === "tablet" && inspector.sheet.open)
        ? panels.reopenHandle
        : null}
      {chrome.footer}
      {chrome.overlay}
    </div>
  );
}
