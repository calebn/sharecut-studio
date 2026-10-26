import type { ReactNode, Ref, RefCallback } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { isHostOnlyTab } from "../presence/followSync";
import type { CompactSheetProps } from "../stage/edit/useCompactInspector";
import type { MobileMode, MoreDestination } from "../state/types";
import { BottomSheet, type SheetPlacement } from "../ui/BottomSheet";
import { INSPECTOR_SHEET_CLASS } from "../ui/compactSheet";
import { Icon, type IconName } from "../ui/Icon";
import { StatusLiveRegion } from "../ui/StatusLiveRegion";
import { ToggleButton } from "../ui/ToggleButton";
import {
  INSPECTOR_COLUMN_SHELL_CLASS,
  type ShellAppearance,
  type ShellNotices,
} from "./shellPresentation";

const MODES: { id: MobileMode; label: string; icon: IconName }[] = [
  { id: "listen", label: "Listen", icon: "listen" },
  { id: "timeline", label: "Timeline", icon: "timeline" },
  { id: "text", label: "Text", icon: "text" },
  { id: "more", label: "More", icon: "more" },
];

export type MobileScreen =
  /** `dock` sits between the scrolling view and the mode bar. */
  | { kind: "listen"; content: ReactNode; dock?: ReactNode }
  | { kind: "timeline"; canvas: ReactNode; tools: ReactNode }
  | { kind: "text"; content: ReactNode }
  | {
      kind: "more";
      destination: MoreDestination;
      content: ReactNode;
      onBack: () => void;
    };

export type MobileSheet =
  | { kind: "closed" }
  | { kind: "mix"; content: ReactNode; onClose: () => void }
  | {
      kind: "inspector";
      /** `column`: beside the timeline on the inline end, not a bottom sheet. */
      placement: SheetPlacement;
      content: ReactNode;
      expanded: boolean;
      onExpandedChange: (expanded: boolean) => void;
      onClose: () => void;
      /** The panel's class when it is not the compact inspector. */
      className?: string;
      /** The compact inspector (peek strip) in place of the half sheet. */
      compact?: CompactSheetProps;
    };

export type MobileShellViewProps = {
  feedbackHostRef?: RefCallback<HTMLDivElement>;
  appearance: ShellAppearance;
  chrome: {
    notices: ShellNotices;
    announcement: string;
    /** Re-speaks a repeated identical announcement (`statusAnnouncementSeq`). */
    announcementSeq?: number;
    transport: ReactNode;
    status: ReactNode;
    overlay: ReactNode;
  };
  screen: MobileScreen;
  onModeChange: (mode: MobileMode) => void;
  sheet: MobileSheet;
  bindings?: {
    root?: Ref<HTMLDivElement>;
    transport?: Ref<HTMLDivElement>;
    text?: Ref<HTMLDivElement>;
    more?: Ref<HTMLDivElement>;
  };
};

export function MobileShellView({
  feedbackHostRef,
  appearance,
  chrome,
  screen,
  onModeChange,
  sheet,
  bindings,
}: MobileShellViewProps) {
  const allowedMore =
    screen.kind === "more" &&
    (!appearance.guestShare || !isHostOnlyTab(screen.destination));
  const inspectorColumn =
    sheet.kind === "inspector" && sheet.placement === "column";
  const sheetPanel = (
    <BottomSheet
      key={sheet.kind}
      backgroundPolicy={sheet.kind === "mix" ? "dismiss" : "interactive"}
      open={sheet.kind !== "closed"}
      onClose={sheet.kind === "closed" ? () => {} : sheet.onClose}
      title={sheet.kind === "mix" ? "Mix" : "Inspector"}
      size={sheet.kind === "mix" ? "full" : "half"}
      placement={sheet.kind === "inspector" ? sheet.placement : "sheet"}
      className={
        sheet.kind === "inspector"
          ? (sheet.className ?? INSPECTOR_SHEET_CLASS)
          : undefined
      }
      expanded={sheet.kind === "inspector" ? sheet.expanded : undefined}
      onExpandedChange={
        sheet.kind === "inspector" ? sheet.onExpandedChange : undefined
      }
      {...(sheet.kind === "inspector" ? sheet.compact : undefined)}
      bodyHeader={
        sheet.kind === "inspector" && sheet.compact && !sheet.compact.stowed ? (
          <div ref={feedbackHostRef} className="compact-feedback-slot" />
        ) : null
      }
    >
      {sheet.kind !== "closed" ? sheet.content : null}
    </BottomSheet>
  );
  return (
    <div
      ref={bindings?.root}
      className={`daw-shell daw-shell--phone${inspectorColumn ? ` ${INSPECTOR_COLUMN_SHELL_CLASS}` : ""}${screen.kind === "listen" ? " daw-shell--listen" : ""}${appearance.guestShare ? " daw-shell-guest" : " daw-shell--attention"}${appearance.following ? " daw-shell--following" : ""}`}
      data-shell="phone"
    >
      <div className="daw-shell-banners">{chrome.notices.banners}</div>
      {chrome.notices.follow}
      <StatusLiveRegion
        message={chrome.announcement}
        seq={chrome.announcementSeq ?? 0}
      />
      {screen.kind !== "listen" ? (
        <div ref={bindings?.transport} className="daw-shell-transport">
          {chrome.transport}
        </div>
      ) : null}
      <main className="mobile-mode-body" tabIndex={-1}>
        <div
          className={
            screen.kind === "listen"
              ? "mobile-status-row"
              : "mobile-status-row mobile-status-row--overlay"
          }
        >
          {chrome.status}
        </div>
        {screen.kind === "listen" && screen.content}
        {screen.kind === "timeline" && (
          <div className="mobile-timeline-mode">
            {screen.canvas}
            {screen.tools}
          </div>
        )}
        {screen.kind === "text" && (
          <div ref={bindings?.text} className="mobile-text-mode">
            {screen.content}
          </div>
        )}
        {screen.kind === "more" && (
          <div ref={bindings?.more} className="mobile-more-mode">
            {allowedMore && (
              <>
                {screen.destination !== "hub" && (
                  <button
                    type="button"
                    className="mobile-back"
                    onClick={() => screen.onBack()}
                  >
                    ← More
                  </button>
                )}
                {screen.content}
              </>
            )}
          </div>
        )}
      </main>
      {sheetPanel}
      {screen.kind === "listen" && screen.dock ? (
        <div className="mobile-dock">{screen.dock}</div>
      ) : null}
      <nav className="mobile-nav" aria-label="Primary">
        {MODES.map(({ id, label, icon }) => (
          <ToggleButton
            key={id}
            pressed={screen.kind === id}
            {...presenceAnchorProps(presenceAnchor("mobile-nav", id))}
            onClick={() => onModeChange(id)}
          >
            <Icon name={icon} size={20} />
            <span>{label}</span>
          </ToggleButton>
        ))}
      </nav>
      {chrome.overlay}
    </div>
  );
}
