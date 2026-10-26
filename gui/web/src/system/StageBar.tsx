import { TabList } from "../ui/Tabs";
import { StatusGlyph } from "./StatusGlyph";
import { SystemIcon } from "./SystemIcon";
import { STATUS_TEXT, type StatusState } from "./statusText";
import { STAGES, type StageId } from "./verbs";

export type StageBadge = { kind: StatusState; count?: number };

export type StageBarProps = {
  active: StageId;
  onSelect: (stage: StageId) => void;
  /** Stages shown, in order. A guest Editor sees two. */
  stages?: readonly StageId[];
  badges?: Partial<Record<StageId, StageBadge>>;
  /** `bar`: header segments. `tabs`: the phone tab bar, an icon over a label. */
  form?: "bar" | "tabs";
  /** Record shows red only while live. */
  live?: boolean;
  label?: string;
  /** Id of the stage content, for `aria-controls`. */
  panelId?: string;
};

function Badge({ badge }: { badge: StageBadge }) {
  const text = STATUS_TEXT[badge.kind];
  return (
    <span className="sys-stage-badge">
      <StatusGlyph state={badge.kind} dot size={12} text={false} />
      {badge.count ? (
        <span aria-hidden="true" className="sys-stage-count">
          {badge.count}
        </span>
      ) : null}
      <span className="sr-only">
        {badge.count ? `${badge.count}, ${text}` : text}
      </span>
    </span>
  );
}

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
  live,
  label = "Stages",
  panelId,
}: StageBarProps) {
  const shown = STAGES.filter((stage) =>
    stages ? stages.includes(stage.id) : true,
  );
  const tabs = shown.map((stage) => {
    const selected = stage.id === active;
    const badge =
      stage.id === "record" && live
        ? ({ kind: "live" } as StageBadge)
        : badges?.[stage.id];
    return (
      <button
        key={stage.id}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={panelId}
        tabIndex={selected ? 0 : -1}
        className={`sys-stage-tab${stage.id === "record" && live ? " sys-stage-tab--live" : ""}`}
        title={stage.label}
        onClick={() => onSelect(stage.id)}
      >
        <SystemIcon name={stage.icon} size={form === "tabs" ? 24 : 16} />
        <span className="sys-stage-label">{stage.label}</span>
        {/* A text node between the label and the badge keeps the words apart in the accessible name. */}
        {badge ? " " : null}
        {badge ? <Badge badge={badge} /> : null}
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
