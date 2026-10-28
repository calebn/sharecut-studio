/**
 * The create menu (#1051 round 4b): a long-press on
 * empty timeline space asks what to make there. Each entry runs an existing
 * command at the held time (`CREATE_ENTRIES` in `inputContract.ts`); one the
 * session cannot run stays in the menu, disabled, with the reason beside it.
 *
 * `hitRouting` owns the gesture: the finger that opened the menu can slide
 * onto an item and lift to pick it (a lift that never moved past the slop
 * picks nothing, whatever the menu lies under), or lift anywhere and tap an
 * item. The
 * scrim, Escape and a second finger close it with no change. A dashed line
 * marks the held time on its lane, so the menu reads as "here".
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COMMANDS } from "../commands/catalog";
import { buildCommandContext, evaluateWhen } from "../commands/context";
import { runPointerCommand } from "../commands/pointer";
import { useDawStore } from "../state/dawStore";
import { selectedTrackIdsOf } from "../state/selection";
import { MenuItem } from "../ui/Menu";
import { useMenuKeyboard } from "../ui/useMenuKeyboard";
import { useTopLayerPanel } from "../ui/useTopLayerPanel";
import { bladeCutNote } from "../utils/bladeTracks";
import { formatTime } from "../utils/time";
import { type ChooserBounds, layoutMenu, naturalSize } from "./chooserLayout";
import {
  CREATE_ITEM_ATTR,
  type CreateView,
  type HitRouter,
} from "./hitRouting";
import {
  CREATE_ENTRIES,
  type CreateEntry,
  type CreatePlace,
} from "./inputContract";

/** The held place, as the timeline resolved it. */
export interface CreateMenuPlace extends CreatePlace {
  /** The held lane's name ("Avery"), if it landed on one. */
  trackLabel: string | null;
  /** The held lane's top and bottom, viewport px, for the time mark. */
  lane: { top: number; bottom: number } | null;
  /** The volume envelope's level at the held time on that lane. */
  level: number | null;
}

interface Item {
  entry: CreateEntry;
  args: Record<string, unknown> | null;
  /** Why it cannot run here, or null. */
  reason: string | null;
  /** What it will act on when that is not the held lane, or null. */
  note: string | null;
}

function items(place: CreatePlace): Item[] {
  const ctx = buildCommandContext();
  const { project, selection, layers } = useDawStore.getState();
  return CREATE_ENTRIES.map((entry) => {
    const args = entry.args(place);
    const gate = evaluateWhen(COMMANDS[entry.command].when, ctx);
    const hiddenEnvelope =
      entry.command === "envelope.addPoint" && !layers.showLevels;
    return {
      entry,
      args,
      reason: !gate.ok
        ? gate.reason
        : hiddenEnvelope
          ? "Show the volume envelope before adding a point"
          : args
            ? null
            : "Hold on a track to add a point",
      note:
        entry.id === "split"
          ? bladeCutNote(project?.tracks ?? [], selectedTrackIdsOf(selection))
          : null,
    };
  });
}

export interface CreateMenuProps {
  view: CreateView;
  place: CreateMenuPlace;
  router: HitRouter;
  /** The timeline's visible box; the menu stays inside it. */
  bounds: ChooserBounds;
  /** The fixed playhead's x on a phone, which the menu sits beside. */
  avoidX: number | null;
}

export function CreateMenu({
  view,
  place,
  router,
  bounds,
  avoidX,
}: CreateMenuProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const topLayer = useTopLayerPanel();
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [list] = useState(() => items(place));
  const time = formatTime(place.atTime);
  const title = place.trackLabel ? `${time} · ${place.trackLabel}` : time;

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box) setSize(naturalSize(box));
  }, []);
  useMenuKeyboard({ open: true, panelRef, close: router.close });
  useEffect(() => {
    const where = place.trackLabel ? ` on ${place.trackLabel}` : "";
    useDawStore
      .getState()
      .announceStatus(`Create at ${time}${where}, ${list.length} actions`, {
        toast: false,
      });
  }, [list.length, place.trackLabel, time]);

  const layout = size
    ? layoutMenu(view.origin, bounds, size, avoidX, {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
      })
    : {
        placement: "above" as const,
        left: view.origin.x,
        top: view.origin.y,
        maxHeight: null,
      };
  const pick = (item: Item) => {
    if (item.reason || !item.args) return;
    router.close();
    runPointerCommand(item.entry.command, item.args);
  };
  const render = (item: Item, index: number) => (
    <MenuItem
      key={item.entry.id}
      over={view.over === index}
      dataAttrs={{ [CREATE_ITEM_ATTR]: String(index) }}
      disabledReason={item.reason ?? undefined}
      description={item.note ?? undefined}
      detail={
        item.entry.id === "envelope-point" && place.level != null
          ? `${place.level.toFixed(2)}×`
          : undefined
      }
      onPointerDown={(e) => {
        // No compatibility mousedown: it would pull focus to the timeline
        // once the menu unmounts.
        e.preventDefault();
      }}
      onSelect={() => pick(item)}
    >
      {item.entry.label}
    </MenuItem>
  );
  const track = list.filter((item) => item.entry.scope === "track");
  const episode = list.filter((item) => item.entry.scope === "episode");

  return createPortal(
    <div
      ref={topLayer.ref}
      popover={topLayer.popover}
      className="create-menu-layer"
      data-placement={layout.placement}
    >
      <div
        className="create-menu-scrim"
        onPointerDown={(e) => {
          e.preventDefault();
          router.close();
        }}
        // A right click outside closes the menu without the native one opening.
        onContextMenu={(e) => e.preventDefault()}
      />
      <svg className="create-menu-mark" aria-hidden="true" focusable="false">
        {place.lane ? (
          <line
            x1={view.origin.x}
            x2={view.origin.x}
            y1={place.lane.top}
            y2={place.lane.bottom}
          />
        ) : null}
        <circle cx={view.origin.x} cy={view.origin.y} r="6" />
      </svg>
      <div
        ref={boxRef}
        className="ui-menu-panel create-menu"
        data-scrolls={
          layout.maxHeight != null && size && size.height > layout.maxHeight
            ? ""
            : undefined
        }
        style={{
          left: layout.left,
          top: layout.top,
          maxBlockSize: layout.maxHeight ?? undefined,
          visibility: size ? "visible" : "hidden",
        }}
      >
        <p className="create-menu-title" aria-hidden="true">
          {title}
        </p>
        <div ref={panelRef} role="menu" aria-label={`Create at ${title}`}>
          {episode.map((item) => render(item, list.indexOf(item)))}
          <hr className="create-menu-separator" />
          {track.map((item) => render(item, list.indexOf(item)))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
