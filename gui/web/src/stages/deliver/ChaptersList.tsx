import { useState } from "react";
import { InlineEdit } from "../../system/InlineEdit";
import { ScrubField } from "../../system/ScrubField";
import { Skeleton } from "../../system/Skeleton";
import { SystemIcon } from "../../system/SystemIcon";
import { VerbButton } from "../../system/VerbButton";
import { hintOf, iconOf, verbOf } from "../../system/verbDisplay";
import { Button, EmptyState } from "../../ui";
import { DeliverSection } from "./DeliverSection";
import { type Chapter, itemNames, snapToSentenceStart } from "./deliverLogic";

type Props = {
  chapters: readonly Chapter[];
  /** Episode length in seconds. */
  total: number;
  /** Seconds where a sentence begins; dragging a time snaps to the nearest. Without them it moves freely. */
  sentenceStarts?: readonly number[];
  state?: "ready" | "loading";
  onRetitle: (id: string, title: string) => void;
  onRetime: (id: string, at: number) => void;
  onPlayFrom: (at: number) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
};

function ChapterTime({
  label,
  at,
  total,
  starts,
  onRetime,
}: {
  label: string;
  at: number;
  total: number;
  starts: readonly number[];
  onRetime: (at: number) => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  return (
    <ScrubField
      label={label}
      value={preview ?? at}
      unit="s"
      decimals={2}
      commitOnUnmount
      min={0}
      max={total}
      step={0.1}
      snap={
        starts.length > 0 ? (v) => snapToSentenceStart(starts, v) : undefined
      }
      onPreview={setPreview}
      onCancel={() => setPreview(null)}
      onCommit={(next) => {
        setPreview(null);
        if (next !== at) onRetime(next);
      }}
    />
  );
}

/** In Edit they stay markers you can move. */
export function ChaptersList({
  chapters,
  total,
  sentenceStarts = [],
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
                <ChapterTime
                  label={`Time of ${names[index]}`}
                  at={chapter.at}
                  total={total}
                  starts={sentenceStarts}
                  onRetime={(at) => onRetime(chapter.id, at)}
                />
                <InlineEdit
                  commitOnUnmount
                  className="dv-chapter-title"
                  label={`Title of ${names[index]}`}
                  value={chapter.title}
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
