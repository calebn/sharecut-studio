import { SessionGroup } from "../../system/SessionGroup";
import { SourceCard } from "../../system/SourceCard";
import type { PrepareSession, SourceActions } from "./prepareTypes";

type SessionSourcesProps = {
  session: PrepareSession;
  /** Position of the session's first card among all cards, so "Voice N" is unique. */
  firstIndex: number;
  actions: SourceActions;
  onTarget?: (target: PrepareSession["target"]) => void;
};

/** One recording session and its Source cards. The stage owns the one hand-off. */
export function SessionSources({
  session,
  firstIndex,
  actions,
  onTarget,
}: SessionSourcesProps) {
  const { sources } = session;
  return (
    <SessionGroup
      title={session.title}
      people={session.people}
      takes={session.takes}
      duration={session.duration}
      target={session.target}
      onTarget={onTarget}
      status={session.status}
      progress={session.progress}
    >
      {sources.length === 0
        ? undefined
        : sources.map((source, at) => (
            <SourceCard
              key={source.id}
              {...source}
              index={firstIndex + at}
              onName={(name) => actions.onName(source.id, name)}
              onRemove={() => actions.onRemove(source.id)}
              onHear={() => actions.onHear(source.id)}
              onVoices={(voices) => actions.onVoices(source.id, voices)}
              onSplit={() => actions.onSplit(source.id)}
              onCancelSplit={() => actions.onCancelSplit(source.id)}
              onRetry={() => actions.onRetry(source.id)}
              onDetails={() => actions.onDetails(source.id)}
              onReplace={() => actions.onReplace(source.id)}
              onMerge={() => actions.onMerge(source.id)}
              onMoveUp={
                at > 0 ? () => actions.onMove(source.id, "up") : undefined
              }
              onMoveDown={
                at < sources.length - 1
                  ? () => actions.onMove(source.id, "down")
                  : undefined
              }
            />
          ))}
    </SessionGroup>
  );
}
