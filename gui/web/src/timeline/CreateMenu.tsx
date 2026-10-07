/**
 * The create menu (#1051 round 4b): a long-press on
 * empty timeline space asks what to make there. Each entry runs an existing
 * command at the held time (`CREATE_ENTRIES` in `inputContract.ts`); one the
 * session cannot run stays in the menu, disabled, with the reason beside it.
 *
 * `hitRouting` owns the gesture: the finger that opened the menu can slide
 * onto an item and lift to pick it, or lift anywhere and tap an item. The
 * scrim, Escape and a second finger close it with no change. A dashed line
 * marks the held time on its lane, so the menu reads as "here".
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COMMANDS } from "../commands/catalog";
import { buildCommandContext, evaluateWhen } from "../commands/context";
import { runPointerCommand } from "../commands/pointer";
import { useDawStore } from "../state/dawStore";
import { useMenuKeyboard } from "../ui/useMenuKeyboard";
import { formatTime } from "../utils/time";
import { type ChooserBounds, layoutMenu } from "./chooserLayout";
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
}

function items(place: CreatePlace): Item[] {
  const ctx = buildCommandContext();
  return CREATE_ENTRIES.map((entry) => {
    const args = entry.args(place);
    const gate = evaluateWhen(COMMANDS[entry.command].when, ctx);
    return {
      entry,
      args,
      reason: !gate.ok
        ? gate.reason
        : args
          ? null
          : "Hold on a track to add a point",
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
  const titleId = useId();
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [list] = useState(() => items(place));
  const time = formatTime(place.atTime);
  const title = place.trackLabel ? `${time} · ${place.trackLabel}` : time;

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box) setSize({ width: box.offsetWidth, height: box.offsetHeight });
  }, []);
  useMenuKeyboard({ open: true, panelRef, close: router.close });
  useEffect(() => {
    const where = place.trackLabel ? ` on ${place.trackLabel}` : "";
    useDawStore
      .getState()
      .announceStatus(`Create at ${time}${where}, ${list.length} actions`);
  }, [list.length, place.trackLabel, time]);

  const layout = size
    ? layoutMenu(view.origin, bounds, size, avoidX)
    : { placement: "above" as const, left: view.origin.x, top: view.origin.y };
  const pick = (item: Item) => {
    if (item.reason || !item.args) return;
    router.close();
    runPointerCommand(item.entry.command, item.args);
  };
  const render = (item: Item, index: number) => {
    const reasonId = `${titleId}-${item.entry.id}`;
    const detail =
      item.entry.id === "envelope-point" && place.level != null
        ? `${place.level.toFixed(2)}×`
        : null;
    return (
      <button
        key={item.entry.id}
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={`ui-control ui-control--quiet create-menu-item${view.over === index ? " is-over" : ""}`}
        aria-disabled={item.reason ? true : undefined}
        aria-describedby={item.reason ? reasonId : undefined}
        {...{ [CREATE_ITEM_ATTR]: String(index) }}
        onPointerDown={(e) => {
          // No compatibility mousedown: it would pull focus to the timeline
          // once the menu unmounts.
          e.preventDefault();
        }}
        onClick={() => pick(item)}
      >
        <span className="create-menu-item-text">
          <span className="ui-menu-item-label">{item.entry.label}</span>
          {item.reason ? (
            <span id={reasonId} className="create-menu-reason">
              {item.reason}
            </span>
          ) : null}
        </span>
        {detail ? (
          <span className="create-menu-detail" aria-hidden="true">
            {detail}
          </span>
        ) : null}
      </button>
    );
  };
  const track = list.filter((item) => item.entry.scope === "track");
  const episode = list.filter((item) => item.entry.scope === "episode");

  return createPortal(
    <div className="create-menu-layer" data-placement={layout.placement}>
      <div
        className="create-menu-scrim"
        onPointerDown={(e) => {
          e.preventDefault();
          router.close();
        }}
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
        style={{
          left: layout.left,
          top: layout.top,
          visibility: size ? "visible" : "hidden",
        }}
      >
        <p className="create-menu-title" aria-hidden="true">
          {title}
        </p>
        <div ref={panelRef} role="menu" aria-label={`Create at ${title}`}>
          {track.map((item) => render(item, list.indexOf(item)))}
          <hr className="create-menu-separator" />
          {episode.map((item) => render(item, list.indexOf(item)))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
