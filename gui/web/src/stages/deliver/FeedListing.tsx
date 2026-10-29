import { useId } from "react";
import { formatBytes } from "../../models";
import { PersonAvatar } from "../../system/Person";
import { Button } from "../../ui";
import { formatClock } from "./deliverLogic";
import {
  type EditControls,
  FactView,
  FeedValue,
  type OnEdit,
} from "./FeedValue";
import {
  audioLabel,
  colorIndexOf,
  DRIFT_COPY,
  formatDate,
  formatDuration,
  isDrifted,
  isKnown,
  KEY,
  markOf,
  numberFact,
  plural,
  roleLabel,
  type SourceOwner,
  textFact,
} from "./feedLogic";
import type { FeedEdit, FeedView } from "./feedView";

type Props = {
  view: FeedView;
  edit: EditControls;
  onEdit: OnEdit;
  onOpenSource: (owner: SourceOwner) => void;
};

function Badge({
  label,
  action,
  onClick,
}: {
  label: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="fd-badge"
      aria-label={`${label}. ${action}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function SourceLink({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button variant="link" className="fd-source" onClick={onClick}>
      {label}
    </Button>
  );
}

function Drift({
  detail,
  onKeep,
  onUseNew,
}: {
  detail: string | undefined;
  onKeep: () => void;
  onUseNew: () => void;
}) {
  return (
    <div className="fd-drift" role="group" aria-label={DRIFT_COPY} data-drift>
      <p>
        {DRIFT_COPY}.
        {detail ? <span className="fd-drift-detail"> {detail}</span> : null}
      </p>
      <div className="fd-drift-actions">
        <Button onClick={onKeep}>Keep mine</Button>
        <Button onClick={onUseNew}>Use new</Button>
      </div>
    </div>
  );
}

export function FeedListing({ view, edit, onEdit, onOpenSource }: Props) {
  const { item, show, sections } = view;
  const notes = textFact(item, KEY.notes);
  const open = (owner: SourceOwner) => () => onOpenSource(owner);
  const chaptersId = useId();
  const withId = useId();
  const keepMine = (value: string): FeedEdit => ({
    op: "set",
    key: KEY.notes,
    value,
  });
  return (
    <article
      className="fd-listing"
      aria-label="How it will look in a podcast app"
    >
      <div className="fd-hero">
        <div className="fd-art-cell">
          <FactView
            fact={sections.art}
            pending={({ why }) => (
              <div className="fd-art fd-art--empty">
                <span className="fd-pending">{why}</span>
              </div>
            )}
          >
            {(art, source) => (
              <>
                <img className="fd-art" src={art.src} alt={art.alt} />
                {markOf(source) ? (
                  <span className="fd-mark">{markOf(source)}</span>
                ) : null}
              </>
            )}
          </FactView>
        </div>
        <div className="fd-head">
          <h3 className="fd-title">
            <FeedValue
              field={KEY.title}
              fact={textFact(item, KEY.title)}
              edit={edit}
              onEdit={onEdit}
            />
          </h3>
          <p className="fd-meta">
            {show.kind === "ready" ? <span>{show.title}</span> : null}
            <FactView fact={textFact(item, KEY.published)}>
              {(iso) => <span>{formatDate(iso)}</span>}
            </FactView>
            <FactView
              fact={numberFact(item, KEY.duration)}
              pending={() => null}
            >
              {(seconds) => <span>{formatDuration(seconds)}</span>}
            </FactView>
          </p>
          <div className="fd-badges">
            <FactView fact={sections.transcripts}>
              {(files) => (
                <Badge
                  label={`Transcript ${files.map((f) => f.format).join(" · ")}`}
                  action="Open transcript"
                  onClick={open("transcript")}
                />
              )}
            </FactView>
            <FactView fact={sections.soundbites}>
              {(bites) => (
                <Badge
                  label={plural(bites.length, "soundbite")}
                  action="Open clips"
                  onClick={open("clips")}
                />
              )}
            </FactView>
          </div>
        </div>
      </div>

      <div className="fd-notes">
        {isKnown(notes) ? (
          <>
            <FeedValue
              field={KEY.notes}
              fact={notes}
              edit={edit}
              onEdit={onEdit}
            />
            {isDrifted(item[KEY.notes]) ? (
              <Drift
                detail={view.driftDetail?.[KEY.notes]}
                onKeep={() => onEdit(keepMine(notes.value))}
                onUseNew={() =>
                  onEdit(
                    { op: "unset", key: KEY.notes },
                    {
                      message: "Your notes are back to auto.",
                      edit: keepMine(notes.value),
                    },
                  )
                }
              />
            ) : null}
          </>
        ) : (
          <>
            <FeedValue
              field={KEY.intro}
              fact={textFact(item, KEY.intro)}
              edit={edit}
              onEdit={onEdit}
            />
            <section className="fd-block" aria-labelledby={chaptersId}>
              <div className="fd-block-head">
                <h4 id={chaptersId} className="fd-label">
                  Chapters
                </h4>
                {isKnown(sections.chapters) ? (
                  <SourceLink
                    label="Edit chapters"
                    onClick={open("chapters")}
                  />
                ) : null}
              </div>
              <FactView fact={sections.chapters}>
                {(chapters) => (
                  <ol className="fd-chapters">
                    {chapters.map((chapter) => (
                      <li key={chapter.at}>
                        <span className="fd-time">
                          {formatClock(chapter.at, true)}
                        </span>
                        {chapter.title}
                      </li>
                    ))}
                  </ol>
                )}
              </FactView>
            </section>
            <section className="fd-block" aria-labelledby={withId}>
              <div className="fd-block-head">
                <h4 id={withId} className="fd-label">
                  With
                </h4>
                {isKnown(sections.credits) ? (
                  <SourceLink
                    label="Edit speakers"
                    onClick={open("speakers")}
                  />
                ) : null}
              </div>
              <FactView fact={sections.credits}>
                {(credits) => (
                  <ul className="fd-people">
                    {credits.map((credit) => (
                      <li key={credit.name} className="fd-person">
                        <PersonAvatar
                          person={{
                            name: credit.name,
                            colorIndex: colorIndexOf(credit.name),
                          }}
                          size={28}
                        />
                        <span className="fd-person-name">{credit.name}</span>
                        <span className="fd-person-role">
                          {roleLabel(credit.role)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </FactView>
            </section>
          </>
        )}
      </div>

      <dl className="fd-facts">
        <div className="fd-fact">
          <dt>Hosting address</dt>
          <dd>
            <FeedValue
              field={KEY.hosting}
              fact={textFact(item, KEY.hosting)}
              edit={edit}
              onEdit={onEdit}
            />
          </dd>
        </div>
        <div className="fd-fact">
          <dt>Audio file</dt>
          <dd>
            <FactView fact={sections.audio}>
              {(audio) => (
                <span>
                  {audioLabel(audio.mime)} · {formatBytes(audio.bytes)}
                </span>
              )}
            </FactView>
          </dd>
        </div>
        <div className="fd-fact">
          <dt>Episode ID</dt>
          <dd>
            <FactView fact={textFact(item, KEY.guid)}>
              {(_, source) => (
                <span>
                  {source.kind === "minted"
                    ? `Assigned ${formatDate(source.at)}. It never changes.`
                    : null}
                </span>
              )}
            </FactView>
          </dd>
        </div>
      </dl>
    </article>
  );
}
