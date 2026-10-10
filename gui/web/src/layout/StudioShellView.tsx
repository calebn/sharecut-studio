import type { DragEventHandler, ReactNode, Ref, RefCallback } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { isHostOnlyTab, studioTabIds } from "../presence/followSync";
import type { LayoutMode } from "../state/types";
import type { PresenceTab } from "../types/session";
import { BottomSheet } from "../ui/BottomSheet";
import { ToggleButton } from "../ui/ToggleButton";
import type {
  SheetPresentation,
  ShellAppearance,
  ShellNotices,
} from "./shellPresentation";
import { TAB_LABELS } from "./tabLabels";

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
  layout: LayoutMode;
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
                aria-label="Drop audio files or import"
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
                    Drop stems here. Use one file per speaker. Import is also
                    under Menu ({workspace.ingest.importShortcut}).
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
      <section
        ref={bindings?.panels}
        className="bottom-tabs"
        aria-label="Editor panels"
      >
        {layout === "default" ? panels.splitter : null}
        <div className="tab-bar">
          {studioTabIds(appearance.guestShare).map((id) => (
            <ToggleButton
              key={id}
              quiet
              pressed={panels.activeTab === id}
              data-ui-kind="tab"
              {...presenceAnchorProps(presenceAnchor("tab", id))}
              onClick={() => panels.onTabChange(id)}
            >
              {TAB_LABELS[id]}
              {id === "pipeline" && panels.pipelineRunning ? " ●" : ""}
            </ToggleButton>
          ))}
        </div>
        <div className="tab-content">
          {!appearance.guestShare || !isHostOnlyTab(panels.activeTab)
            ? panels.content
            : null}
        </div>
      </section>
      {chrome.footer}
      {inspector.kind === "tablet" ? (
        <BottomSheet
          backgroundPolicy="interactive"
          open={inspector.sheet.open}
          onClose={inspector.sheet.onClose}
          title="Inspector"
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
      ) : null}
      {chrome.overlay}
    </div>
  );
}
