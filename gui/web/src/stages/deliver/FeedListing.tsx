import { useId } from "react";
import { formatBytes } from "../../models";
import { PersonAvatar } from "../../system/Person";
import { Button } from "../../ui";
import { type EditControls, FeedValue, PendingNote } from "./FeedValue";
import {
  audioLabel,
  driftCopy,
  formatDate,
  formatDuration,
  formatStamp,
  isKnown,
  plural,
  roleLabel,
} from "./feedLogic";
import type { FeedEdit, FeedView, Fix, SourceOwner } from "./feedView";

type Props = {
  view: FeedView;
  edit: EditControls;
  onEdit: (edit: FeedEdit) => void;
  onFix: (fix: Fix) => void;
  onOpenSource: (owner: SourceOwner) => void;
};

function Art({
  item,
  onFix,
}: {
  item: FeedView["item"];
  onFix: Props["onFix"];
}) {
  const art = item.art;
  if (isKnown(art)) {
    return <img className="fd-art" src={art.value.src} alt={art.value.alt} />;
  }
  return (
    <div className="fd-art fd-art--empty">
      <PendingNote why={art.source.why} fix={art.source.fix} onFix={onFix} />
    </div>
  );
}

function Badge({
  label,
  name,
  onClick,
}: {
  label: string;
  name: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="fd-badge"
      aria-label={name}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function Drift({
  source,
  onKeep,
  onUseNew,
}: {
  source: Parameters<typeof driftCopy>[0];
  onKeep: () => void;
  onUseNew: () => void;
}) {
  return (
    <div
      className="fd-drift"
      role="group"
      aria-label="Changed since you edited this"
    >
      <p>{driftCopy(source)}</p>
      <div className="fd-drift-actions">
        <Button onClick={onKeep}>Keep mine</Button>
        <Button onClick={onUseNew}>Use new</Button>
      </div>
    </div>
  );
}

export function FeedListing({
  view,
  edit,
  onEdit,
  onFix,
  onOpenSource,
}: Props) {
  const { item, show } = view;
  const { notes, chapters, credits, transcripts, soundbites } = item;
  const open = (owner: SourceOwner) => () => onOpenSource(owner);
  const chaptersId = useId();
  const withId = useId();
  return (
    <article
      className="fd-listing"
      aria-label="How it will look in a podcast app"
    >
      <div className="fd-hero">
        <Art item={item} onFix={onFix} />
        <div className="fd-head">
          <h3 className="fd-title">
            <FeedValue
              field="item.title"
              fact={item.title}
              edit={edit}
              onEdit={onEdit}
              onFix={onFix}
            />
          </h3>
          <p className="fd-meta">
            {show.kind === "ready" ? <span>{show.title}</span> : null}
            {isKnown(item.publishedAt) ? (
              <span>{formatDate(item.publishedAt.value)}</span>
            ) : (
              <PendingNote
                why={item.publishedAt.source.why}
                fix={item.publishedAt.source.fix}
                onFix={onFix}
              />
            )}
            {isKnown(item.duration) ? (
              <span>{formatDuration(item.duration.value)}</span>
            ) : null}
          </p>
          <div className="fd-badges">
            {isKnown(transcripts) ? (
              <Badge
                label={`Transcript ${transcripts.value.join(" · ")}`}
                name={`Transcript in ${transcripts.value.join(" and ")}. Open transcript`}
                onClick={open("transcript")}
              />
            ) : (
              <PendingNote
                why={transcripts.source.why}
                fix={transcripts.source.fix}
                onFix={onFix}
              />
            )}
            {isKnown(soundbites) ? (
              <Badge
                label={plural(soundbites.value.length, "soundbite")}
                name={`${plural(soundbites.value.length, "soundbite")}. Open clips`}
                onClick={open("clips")}
              />
            ) : (
              <PendingNote
                why={soundbites.source.why}
                fix={soundbites.source.fix}
                onFix={onFix}
              />
            )}
          </div>
        </div>
      </div>

      <div className="fd-notes">
        {notes && isKnown(notes) ? (
          <>
            <FeedValue
              field="item.notes"
              fact={notes}
              edit={edit}
              onEdit={onEdit}
              onFix={onFix}
            />
            {notes.source.kind === "pinned" && notes.source.drifted ? (
              <Drift
                source={notes.source.drifted}
                onKeep={() =>
                  onEdit({ op: "set", key: "item.notes", value: notes.value })
                }
                onUseNew={() => onEdit({ op: "unset", key: "item.notes" })}
              />
            ) : null}
          </>
        ) : (
          <>
            <FeedValue
              field="item.intro"
              fact={item.intro}
              edit={edit}
              onEdit={onEdit}
              onFix={onFix}
            />
            <section className="fd-block" aria-labelledby={chaptersId}>
              <div className="fd-block-head">
                <h4 id={chaptersId} className="fd-label">
                  Chapters
                </h4>
                {isKnown(chapters) ? (
                  <Button variant="link" onClick={open("chapters")}>
                    Edit chapters
                  </Button>
                ) : null}
              </div>
              {isKnown(chapters) ? (
                <ol className="fd-chapters">
                  {chapters.value.map((chapter) => (
                    <li key={chapter.at}>
                      <span className="fd-time">{formatStamp(chapter.at)}</span>
                      {chapter.title}
                    </li>
                  ))}
                </ol>
              ) : (
                <PendingNote
                  why={chapters.source.why}
                  fix={chapters.source.fix}
                  onFix={onFix}
                />
              )}
            </section>
            <section className="fd-block" aria-labelledby={withId}>
              <div className="fd-block-head">
                <h4 id={withId} className="fd-label">
                  With
                </h4>
                {isKnown(credits) ? (
                  <Button variant="link" onClick={open("speakers")}>
                    Edit speakers
                  </Button>
                ) : null}
              </div>
              {isKnown(credits) ? (
                <ul className="fd-people">
                  {credits.value.map((credit) => (
                    <li key={credit.name} className="fd-person">
                      <PersonAvatar person={credit} size={28} />
                      <span className="fd-person-name">{credit.name}</span>
                      <span className="fd-person-role">
                        {roleLabel(credit.role)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <PendingNote
                  why={credits.source.why}
                  fix={credits.source.fix}
                  onFix={onFix}
                />
              )}
            </section>
          </>
        )}
      </div>

      <dl className="fd-facts">
        <div className="fd-fact">
          <dt>Hosting address</dt>
          <dd>
            <FeedValue
              field="item.enclosure.url"
              fact={item.hosting}
              edit={edit}
              onEdit={onEdit}
              onFix={onFix}
            />
          </dd>
        </div>
        <div className="fd-fact">
          <dt>Audio file</dt>
          <dd>
            {isKnown(item.file) ? (
              <span>
                {audioLabel(item.file.value.mime)} ·{" "}
                {formatBytes(item.file.value.bytes)}
              </span>
            ) : (
              <PendingNote
                why={item.file.source.why}
                fix={item.file.source.fix}
                onFix={onFix}
              />
            )}
          </dd>
        </div>
      </dl>
    </article>
  );
}
