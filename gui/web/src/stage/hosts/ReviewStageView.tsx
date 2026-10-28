import type { ReactNode, Ref } from "react";
import { presenceAnchor, presenceAnchorProps } from "../../presence/anchors";
import { wireTabOf } from "../../state/stageRoutes";
import type { ShellBreakpoint } from "../../state/types";
import type { ReviewSection } from "../../types/stage";
import { Button } from "../../ui";
import { Tab, TabList } from "../../ui/Tabs";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { TAB_LABELS } from "../frame/tabLabels";
import { HostBody } from "./HostBody";
import type { HostState } from "./hostModels";

const TAB_ID = "review-section-tab";
const PANEL_ID = "review-section-panel";

export type ReviewStageViewProps = {
  shell: ShellBreakpoint;
  state: HostState;
  failure?: LoadFailure | null;
  sections: readonly ReviewSection[];
  active: ReviewSection;
  /** A dot after the label: pending edits, open comments. */
  waiting: Partial<Record<ReviewSection, boolean>>;
  onSection: (section: ReviewSection) => void;
  /** The active section's panel. */
  panel: ReactNode;
  /** Offered to the host once review is done. */
  onDeliver?: () => void;
  scrollRef?: Ref<HTMLDivElement>;
};

/** Review: Queue, Comments and Tighten as sections of one stage. */
export function ReviewStageView({
  shell,
  state,
  failure,
  sections,
  active,
  waiting,
  onSection,
  panel,
  onDeliver,
  scrollRef,
}: ReviewStageViewProps) {
  return (
    <HostBody stage="review" shell={shell} state={state} failure={failure}>
      {sections.length > 1 ? (
        <TabList label="Review sections" className="stage-host-tabs">
          {sections.map((id) => (
            <Tab
              key={id}
              id={`${TAB_ID}-${id}`}
              panelId={PANEL_ID}
              selected={active === id}
              {...presenceAnchorProps(presenceAnchor("tab", id))}
              onClick={() => onSection(id)}
            >
              {TAB_LABELS[wireTabOf(id)]}
              {waiting[id] ? " ●" : ""}
            </Tab>
          ))}
        </TabList>
      ) : null}
      <div
        ref={scrollRef}
        id={PANEL_ID}
        className="stage-host-panel"
        role={sections.length > 1 ? "tabpanel" : "region"}
        aria-labelledby={
          sections.length > 1 ? `${TAB_ID}-${active}` : undefined
        }
        aria-label={
          sections.length > 1 ? undefined : TAB_LABELS[wireTabOf(active)]
        }
      >
        {panel}
      </div>
      {onDeliver ? (
        <div className="stage-host-handoff">
          <Button onClick={onDeliver}>Deliver</Button>
        </div>
      ) : null}
    </HostBody>
  );
}
