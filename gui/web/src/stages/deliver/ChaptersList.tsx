import { useEffect, useEffectEvent, useState } from "react";
import { Skeleton } from "../../system/Skeleton";
import { SystemIcon } from "../../system/SystemIcon";
import { TimeField } from "../../system/TimeField";
import { VerbButton } from "../../system/VerbButton";
import { hintOf, iconOf, verbOf } from "../../system/verbDisplay";
import { Button, EmptyState } from "../../ui";
import { DeliverSection } from "./DeliverSection";
import {
  type Chapter,
  formatClock,
  itemNames,
  parseClock,
} from "./deliverLogic";

type Props = {
  chapters: readonly Chapter[];
  /** Episode length in seconds. */
  total: number;
  state?: "ready" | "loading";
  onRetitle: (id: string, title: string) => void;
  onRetime: (id: string, at: number) => void;
  onPlayFrom: (at: number) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
};

function ChapterTitle({
  label,
  title,
  onCommit,
}: {
  label: string;
  title: string;
  onCommit: (title: string) => void;
}) {
  const [text, setText] = useState(title);
  const [seen, setSeen] = useState(title);
  if (title !== seen) {
    setSeen(title);
    setText(title);
  }
  const commit = () => {
    if (text !== title) onCommit(text);
  };
  const leave = useEffectEvent(commit);
  useEffect(() => () => leave(), []);
  return (
    <form
      className="dv-chapter-form"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <input
        className="dv-chapter-title"
        aria-label={label}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
      />
    </form>
  );
}

/** In Edit they stay markers you can move. */
export function ChaptersList({
  chapters,
  total,
  state = "ready",
  onRetitle,
  onRetime,
  onPlayFrom,
  onRemove,
  onAdd,
}: Props) {
  const add = verbOf("addChapter");
  const names = itemNames(
    chapters.map((c) => c.title),
    "chapter",
  );
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
  return (
    <DeliverSection title="Chapters">
      {chapters.length === 0 ? (
        <EmptyState as="div">
          Chapters help listeners skip around.
          {addButton}
        </EmptyState>
      ) : (
        <>
          <ul className="dv-chapters" data-focus-list="chapters">
            {chapters.map((chapter, index) => (
              <li key={chapter.id} className="dv-chapter">
                <TimeField
                  label={`Time of ${names[index]}`}
                  value={chapter.at}
                  min={0}
                  max={total}
                  step={0.1}
                  format={formatClock}
                  parse={parseClock}
                  onChange={(at) => onRetime(chapter.id, at)}
                />
                <ChapterTitle
                  label={`Title of ${names[index]}`}
                  title={chapter.title}
                  onCommit={(title) => onRetitle(chapter.id, title)}
                />
                <VerbButton
                  verb="play"
                  label={`Play from ${names[index]}`}
                  onClick={() => onPlayFrom(chapter.at)}
                />
                <VerbButton
                  verb="remove"
                  label={`Remove ${names[index]}`}
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
