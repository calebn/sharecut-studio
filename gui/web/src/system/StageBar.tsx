import type { StageId } from "../types/stage";
import { TabList } from "../ui/Tabs";
import type { RecordBadge, StageBadge } from "./StageBadgeViews";
import { SystemIcon } from "./SystemIcon";
import { stageBadge } from "./stageBadge";
import { STAGES } from "./verbs";

export type StageBarProps = {
  active: StageId;
  onSelect: (stage: StageId) => void;
  /** Stages shown, in order. A guest Editor sees two. */
  stages?: readonly StageId[];
  badges?: Partial<Record<StageId, StageBadge>>;
  /** `bar`: header segments. `tabs`: the phone tab bar, an icon over a label. */
  form?: "bar" | "tabs";
  /** What the Record item says about the room; a `failed` badge for Record outranks it. */
  record?: RecordBadge;
  label?: string;
  /** Id of the stage content, for `aria-controls`. */
  panelId?: string;
};

/**
 * The five stages as one tab list; `ui/Tabs` owns the roving keys. Under 1100 px
 * (68.75rem) the inactive segments show the icon only and keep the label in the
 * accessible name. The width is the nearest container's: the App header, or
 * the bar itself when it stands alone.
 */
export function StageBar({
  active,
  onSelect,
  stages,
  badges,
  form = "bar",
  record,
  label = "Stages",
  panelId,
}: StageBarProps) {
  const shown = STAGES.filter((stage) =>
    stages ? stages.includes(stage.id) : true,
  );
  const tabs = shown.map((stage) => {
    const selected = stage.id === active;
    const badge = stageBadge(stage.id, badges, record);
    return (
      <button
        key={stage.id}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={panelId}
        tabIndex={selected ? 0 : -1}
        className="sys-stage-tab"
        title={stage.label}
        onClick={() => onSelect(stage.id)}
      >
        <SystemIcon name={stage.icon} size={form === "tabs" ? 24 : 16} />
        <span className="sys-stage-label">{stage.label}</span>
        {/* A text node between the label and the badge keeps the words apart in the accessible name. */}
        {badge ? " " : null}
        {badge}
      </button>
    );
  });
  return (
    <div className={`sys-stage-bar sys-stage-bar--${form}`}>
      <TabList label={label} className="sys-stage-list">
        {tabs}
      </TabList>
    </div>
  );
}
