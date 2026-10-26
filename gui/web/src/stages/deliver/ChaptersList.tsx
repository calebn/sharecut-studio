import { TimeField } from "../../system/TimeField";
import { Skeleton } from "../../system/Skeleton";
import { StatusRow } from "../../system/StatusRow";
import { SystemIcon } from "../../system/SystemIcon";
import { VerbButton } from "../../system/VerbButton";
import { hintOf, iconOf, verbOf } from "../../system/verbDisplay";
import { Button, EmptyState } from "../../ui";
import { DeliverSection } from "./DeliverSection";
import { type Chapter, formatClock, parseClock } from "./deliverLogic";

type Props = {
  chapters: readonly Chapter[];
  /** Episode length in seconds. */
  total: number;
  state?: "ready" | "loading" | "error";
  onRetitle: (id: string, title: string) => void;
  onRetime: (id: string, at: number) => void;
  onPlayFrom: (at: number) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onRetry?: () => void;
};

/** The episode's chapters as a list. In Edit they stay markers you can move. */
export function ChaptersList({
  chapters,
  total,
  state = "ready",
  onRetitle,
  onRetime,
  onPlayFrom,
  onRemove,
  onAdd,
  onRetry,
}: Props) {
  const add = verbOf("addChapter");
  const addButton = (
    <Button onClick={onAdd} title={`${add.label}${hintOf(add)}`}>
      <SystemIcon name={iconOf("addChapter")} size={14} />
      Add at playhead
    </Button>
  );
  if (state === "loading") {
    return (
      <DeliverSection title="Chapters">
        <Skeleton layout="list" rows={3} />
      </DeliverSection>
    );
  }
  if (state === "error") {
    return (
      <DeliverSection title="Chapters">
        <StatusRow
          state="failed"
          title="Could not load the chapters"
          action={
            onRetry ? { label: "Try again", onAction: onRetry } : undefined
          }
        />
      </DeliverSection>
    );
  }
  return (
    <DeliverSection title="Chapters">
      {chapters.length === 0 ? (
        <EmptyState as="div">
          Chapters help listeners skip around.
          {addButton}
        </EmptyState>
      ) : (
        <>
          <ul className="dv-chapters">
            {chapters.map((chapter) => (
              <li key={chapter.id} className="dv-chapter">
                <TimeField
                  label={`Time of ${chapter.title}`}
                  value={chapter.at}
                  min={0}
                  max={total}
                  step={0.1}
                  format={formatClock}
                  parse={parseClock}
                  onChange={(at) => onRetime(chapter.id, at)}
                />
                <input
                  className="dv-chapter-title"
                  aria-label={`Title of ${chapter.title}`}
                  value={chapter.title}
                  onChange={(event) =>
                    onRetitle(chapter.id, event.target.value)
                  }
                />
                <VerbButton
                  verb="play"
                  label={`Play from ${chapter.title}`}
                  onClick={() => onPlayFrom(chapter.at)}
                />
                <VerbButton
                  verb="remove"
                  label={`Delete ${chapter.title}`}
                  onClick={() => onRemove(chapter.id)}
                />
              </li>
            ))}
          </ul>
          {addButton}
        </>
      )}
    </DeliverSection>
  );
}
