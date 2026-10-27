import { SessionGroup } from "../../system/SessionGroup";
import { SourceCard } from "../../system/SourceCard";
import type { PrepareSession, SourceActions } from "./prepareTypes";

type SessionSourcesProps = {
  session: PrepareSession;
  /** Position of the session's first card among all cards, so "Voice N" is unique. */
  firstIndex: number;
  /** Lower-case names that more than one voice has, across every session. Only the control names use it. */
  repeated?: ReadonlySet<string>;
  actions: SourceActions;
  onTarget?: (target: PrepareSession["target"]) => void;
};

/** One recording session and its Source cards. The stage owns the one hand-off. */
export function SessionSources({
  session,
  firstIndex,
  repeated,
  actions,
  onTarget,
}: SessionSourcesProps) {
  const { sources } = session;
  const here = new Map<string, number>();
  for (const source of sources) {
    const key = source.name.trim().toLowerCase();
    if (key) here.set(key, (here.get(key) ?? 0) + 1);
  }
  return (
    <SessionGroup
      title={session.title}
      people={session.people}
      takes={session.takes}
      duration={session.duration}
      target={session.target}
      targetFor={session.title}
      onTarget={onTarget}
      status={session.status}
      progress={session.progress}
    >
      {sources.length === 0
        ? undefined
        : sources.map((source, at) => {
            const key = source.name.trim().toLowerCase();
            const sameNameAs =
              source.sameNameAs ??
              ((here.get(key) ?? 0) > 1 ? source.name.trim() : undefined);
            return (
              <SourceCard
                key={source.id}
                {...source}
                sameNameAs={sameNameAs}
                nameElsewhere={
                  !sameNameAs && repeated?.has(key)
                    ? source.name.trim()
                    : undefined
                }
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
            );
          })}
    </SessionGroup>
  );
}
