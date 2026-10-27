import { type ReactNode, useState } from "react";
import { AppHeader, type HeaderPerson } from "../../system/AppHeader";
import { Cover } from "../../system/Cover";
import type { OverviewTick } from "../../system/OverviewStrip";
import { Player } from "../../system/Player";
import type { SaveIndicatorProps } from "../../system/SaveIndicator";
import { ScriptPane } from "../../system/ScriptPane";
import { Skeleton } from "../../system/Skeleton";
import { StageBar } from "../../system/StageBar";
import type { ScriptTurn } from "../../system/scriptPieces";
import type { StageId } from "../../system/verbs";
import { clamp, lastIndexAtOrBefore } from "../../utils/math";
import { formatTimeShort } from "../../utils/time";
import { type GuestRole, guestStages, ROLE_HINT } from "./guestLogic";

export type GuestReviewProps = {
  access: GuestRole;
  title: string;
  version: string;
  people?: readonly HeaderPerson[];
  save?: SaveIndicatorProps;
  turns: readonly ScriptTurn[];
  /** Start second of each word, by word index, ascending. */
  wordStarts: readonly number[];
  /** Episode length in seconds. */
  duration: number;
  peaks?: readonly number[];
  ticks?: readonly OverviewTick[];
  initialPlayhead?: number;
  initialPlaying?: boolean;
  layout?: "desktop" | "phone";
  /** `bad-link`: the link opens nothing; a Cover, never the server's answer. */
  state?: "ready" | "loading" | "error" | "bad-link";
  edit?: ReactNode;
  /** First visit on this link: the Role chip explains itself once. The app stores that it was seen. */
  firstVisit?: boolean;
  onRoleHintSeen?: () => void;
  /** The Review lane's Composer drops in here; a viewer never gets it. */
  composer?: ReactNode;
  onComment?: () => void;
  onRetry?: () => void;
};

export function GuestReview({
  access,
  title,
  version,
  people,
  save = { state: "saved" },
  turns,
  wordStarts,
  duration,
  peaks,
  ticks,
  initialPlayhead = 0,
  initialPlaying = false,
  layout = "desktop",
  state = "ready",
  edit,
  firstVisit = false,
  onRoleHintSeen,
  composer,
  onComment,
  onRetry,
}: GuestReviewProps) {
  const [playhead, setPlayhead] = useState(initialPlayhead);
  const [playing, setPlaying] = useState(initialPlaying);
  const [following, setFollowing] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [hintShown, setHintShown] = useState(firstVisit);
  const [tab, setTab] = useState<StageId>("review");
  const phone = layout === "phone";
  const stages = guestStages(access);

  if (state === "bad-link") {
    return (
      <div className="gr-stage" data-layout={layout}>
        <main>
          <Cover
            size="page"
            glyph="octagon-alert"
            title="This link doesn't open anything"
          >
            Ask the person who sent it for a new link.
          </Cover>
        </main>
      </div>
    );
  }

  const seek = (to: number) => setPlayhead(clamp(to, 0, duration));
  const tabs = stages
    ? { active: tab, stages, onSelect: setTab, label: "Stages" }
    : undefined;
  const header = (
    <AppHeader
      title={title}
      save={save}
      people={people}
      guest={{
        version,
        role: access,
        compact: phone,
        hint: {
          text: ROLE_HINT[access],
          shown: hintShown,
          onDismiss: () => {
            setHintShown(false);
            onRoleHintSeen?.();
          },
        },
      }}
      stages={phone ? undefined : tabs}
      loading={state === "loading"}
    />
  );

  let content: ReactNode;
  if (state === "loading") {
    content = <Skeleton layout="list" rows={4} />;
  } else if (state === "error") {
    content = (
      <Cover
        size="region"
        glyph="octagon-alert"
        title="Could not load this review"
        primary={onRetry ? { label: "Try again", onClick: onRetry } : undefined}
      >
        Nothing you wrote is lost.
      </Cover>
    );
  } else if (tab === "edit") {
    content = edit ?? (
      <Cover size="region" glyph="eye-off" title="Edit opens here">
        The Edit stage is wired with the app.
      </Cover>
    );
  } else {
    const player = (
      <Player
        form={phone && collapsed ? "bar" : "expanded"}
        guest
        playing={playing}
        time={formatTimeShort(playhead)}
        total={formatTimeShort(duration)}
        title={title}
        peaks={peaks}
        ticks={ticks}
        playhead={playhead / duration}
        onPlayPause={() => setPlaying((now) => !now)}
        onSkip={(seconds) => seek(playhead + seconds)}
        onComment={access !== "viewer" ? onComment : undefined}
        onExpand={() => setCollapsed(false)}
        onCollapse={phone ? () => setCollapsed(true) : undefined}
      />
    );
    const composerPart = access !== "viewer" ? composer : null;
    const script =
      turns.length === 0 ? (
        <Cover size="region" glyph="inbox" title="Nothing to read yet">
          The host has not made a transcript of this version.
        </Cover>
      ) : (
        <ScriptPane
          turns={turns}
          layout={layout}
          guest={access === "viewer" ? "viewer" : "commenter"}
          playing={lastIndexAtOrBefore(wordStarts, playhead)}
          following={following}
          onSeek={(word) => seek(wordStarts[word] ?? playhead)}
          onUserScroll={() => {
            setFollowing(false);
            if (phone) setCollapsed(true);
          }}
          onBackToPlayhead={() => setFollowing(true)}
          onFollowChange={setFollowing}
        />
      );
    content = (
      <div className="gr-column">
        <div className="gr-player">{player}</div>
        {phone ? null : composerPart}
        <div className="gr-script">{script}</div>
        {phone ? composerPart : null}
      </div>
    );
  }

  return (
    <div className="gr-stage" data-layout={layout}>
      {header}
      <main className="gr-body" aria-busy={state === "loading" || undefined}>
        {content}
      </main>
      {phone && tabs ? (
        <nav aria-label="Review stages">
          <StageBar {...tabs} form="tabs" />
        </nav>
      ) : null}
    </div>
  );
}
