import type { ReactNode, Ref } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { isHostOnlyTab } from "../presence/followSync";
import type { MobileMode, MoreDestination } from "../state/types";
import { BottomSheet } from "../ui/BottomSheet";
import { Icon, type IconName } from "../ui/Icon";
import { ToggleButton } from "../ui/ToggleButton";
import type {
  SheetPresentation,
  ShellAppearance,
  ShellNotices,
} from "./shellPresentation";

const MODES: { id: MobileMode; label: string; icon: IconName }[] = [
  { id: "listen", label: "Listen", icon: "listen" },
  { id: "timeline", label: "Timeline", icon: "timeline" },
  { id: "text", label: "Text", icon: "text" },
  { id: "more", label: "More", icon: "more" },
];

export type MobileScreen =
  | { kind: "listen"; content: ReactNode }
  | { kind: "timeline"; canvas: ReactNode; tools: ReactNode }
  | { kind: "text"; content: ReactNode }
  | {
      kind: "more";
      destination: MoreDestination;
      content: ReactNode;
      onBack: () => void;
    };

export type MobileShellViewProps = {
  appearance: ShellAppearance;
  chrome: {
    notices: ShellNotices;
    announcement: string;
    transport: ReactNode;
    recording: ReactNode;
    overlay: ReactNode;
  };
  screen: MobileScreen;
  onModeChange: (mode: MobileMode) => void;
  inspector: SheetPresentation;
  bindings?: {
    root?: Ref<HTMLDivElement>;
    transport?: Ref<HTMLDivElement>;
    text?: Ref<HTMLDivElement>;
    more?: Ref<HTMLDivElement>;
  };
};

export function MobileShellView({
  appearance,
  chrome,
  screen,
  onModeChange,
  inspector,
  bindings,
}: MobileShellViewProps) {
  const allowedMore =
    screen.kind === "more" &&
    (!appearance.guestShare || !isHostOnlyTab(screen.destination));
  return (
    <div
      ref={bindings?.root}
      className={`daw-shell daw-shell--phone${screen.kind === "listen" ? " daw-shell--listen" : ""}${appearance.guestShare ? " daw-shell-guest" : " daw-shell--attention"}${appearance.following ? " daw-shell--following" : ""}`}
      data-shell="phone"
    >
      <div className="daw-shell-banners">{chrome.notices.banners}</div>
      {chrome.notices.follow}
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {chrome.announcement}
      </span>
      {screen.kind !== "listen" ? (
        <div ref={bindings?.transport} className="daw-shell-transport">
          {chrome.transport}
        </div>
      ) : null}
      <main className="mobile-mode-body">
        <div className="mobile-record-status">{chrome.recording}</div>
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
      <BottomSheet
        backgroundPolicy="interactive"
        open={inspector.open}
        onClose={inspector.onClose}
        title="Inspector"
        expanded={inspector.expanded}
        onExpandedChange={inspector.onExpandedChange}
      >
        {inspector.content}
      </BottomSheet>
      {chrome.overlay}
    </div>
  );
}
