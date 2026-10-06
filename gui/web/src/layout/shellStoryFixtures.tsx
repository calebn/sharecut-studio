import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import type { LayoutMode, ShellBreakpoint, ToolMode } from "../state/types";
import { TrackHeaderView } from "../tracks/TrackHeaderView";
import { TranscriptTurnView } from "../transcript/TranscriptTurnView";
import { Timecode } from "../ui/Timecode";
import { shellProject, shellTime } from "./shellStoryData";
import { ToolModeToggleView } from "./ToolModeToggleView";
import { TransportFrame, TransportZone } from "./TransportFrame";
import { TransportPlayControls } from "./TransportPlayControls";

export function ShellStoryFrame({
  shell = "desktop",
  layout = "default",
  children,
  tabsHeight = 12.5,
}: {
  shell?: ShellBreakpoint;
  layout?: LayoutMode;
  children: ReactNode;
  tabsHeight?: number;
}) {
  useEffect(() => {
    const root = document.documentElement;
    const previousShell = root.dataset.shell;
    const previousLayout = root.dataset.layout;
    const previousHeight = root.style.getPropertyValue("--tabs-height");
    root.dataset.shell = shell;
    if (layout === "default") delete root.dataset.layout;
    else root.dataset.layout = layout;
    root.style.setProperty("--tabs-height", `${tabsHeight}rem`);
    return () => {
      if (previousShell == null) delete root.dataset.shell;
      else root.dataset.shell = previousShell;
      if (previousLayout == null) delete root.dataset.layout;
      else root.dataset.layout = previousLayout;
      if (previousHeight)
        root.style.setProperty("--tabs-height", previousHeight);
      else root.style.removeProperty("--tabs-height");
    };
  }, [shell, layout, tabsHeight]);
  return (
    <div
      style={
        {
          inlineSize: shell === "phone" ? "360px" : "100%",
          minInlineSize:
            shell === "desktop"
              ? "70rem"
              : shell === "tablet"
                ? "48rem"
                : undefined,
          maxInlineSize: "100%",
          blockSize: "100dvh",
          "--tabs-height": `${tabsHeight}rem`,
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

export function ShellStoryTransport({
  compact,
  loading = false,
  playing,
  onPlayingChange,
}: {
  compact: boolean;
  loading?: boolean;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
}) {
  return (
    <TransportFrame compact={compact} collapsed={compact} playing={playing}>
      <TransportZone position="start">
        <h1>{loading ? "Loading episode…" : shellProject.meta.name}</h1>
      </TransportZone>
      <TransportZone position="center">
        <div className="transport-play">
          <TransportPlayControls
            playing={playing}
            disabled={loading}
            onTogglePlay={() => onPlayingChange(!playing)}
            onStop={() => onPlayingChange(false)}
          />
        </div>
        <Timecode
          current={shellTime.current}
          total={compact ? undefined : shellTime.total}
        />
      </TransportZone>
      <TransportZone position="end">
        {compact ? null : <ShellStoryTools />}
      </TransportZone>
    </TransportFrame>
  );
}

export function ShellStoryTools() {
  const [tool, setTool] = useState<ToolMode>("select");
  const [comment, setComment] = useState(false);
  return (
    <ToolModeToggleView
      compact
      structuralToolsAllowed
      toolMode={tool}
      commentMode={comment}
      selectTitle="Select tool"
      bladeTitle="Blade tool"
      commentTitle="Comment mode"
      onSelect={() => {
        setTool("select");
        setComment(false);
      }}
      onBlade={() => {
        setTool("blade");
        setComment(false);
      }}
      onToggleComment={() => setComment((value) => !value)}
    />
  );
}

export function ShellStoryHeaders({
  selected = false,
  onInspect,
}: {
  selected?: boolean;
  onInspect: (trackId: string) => void;
}) {
  return (
    <div className="track-headers">
      <TrackHeaderView
        track={shellProject.tracks[0]}
        trackIndex={0}
        selected={selected}
        muteState="off"
        stemClass="fresh"
        wholeReasons={[]}
        hasRegional={false}
        headerHighlight={false}
        dropHighlight={false}
        dragging={false}
        dropEdge={null}
        mayReorder={false}
        mixer={null}
        onSelect={() => onInspect("mira")}
      />
    </div>
  );
}

export function ShellStoryTimeline({
  selected,
  onInspect,
}: {
  selected: boolean;
  onInspect: (trackId: string) => void;
}) {
  return (
    <section className="timeline-area" aria-label="Timeline fixture">
      <div className="timeline-scroll">
        <div className="timeline-lock-inner timeline-lock-inner--headers">
          <ShellStoryHeaders selected={selected} onInspect={onInspect} />
          <div className="timeline-content">
            <p>Mira · 1m dialogue</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ShellStoryTranscript({
  onSeek,
}: {
  onSeek: (sec: number) => void;
}) {
  const [selected, setSelected] = useState(false);
  return (
    <div className="transcript-panel">
      <div className="transcript-list">
        <TranscriptTurnView
          speaker="Mira"
          labelSec={12.5}
          seekSec={12.5}
          onSeek={() => onSeek(12.5)}
          segments={[
            {
              key: "mira-introduction",
              words: [
                {
                  trackId: "mira",
                  word: {
                    text: "Welcome.",
                    start: 12.5,
                    end: 13,
                    word_index: 0,
                  },
                  interactive: true,
                  selected,
                  buttonProps: {
                    onClick: () => {
                      setSelected(true);
                      onSeek(12.5);
                    },
                  },
                },
              ],
            },
          ]}
        />
      </div>
    </div>
  );
}

export function ShellStoryInspector() {
  return (
    <div className="inspector">
      <strong>Mira</strong>
      <p>Dialogue track</p>
    </div>
  );
}
