import { memo, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { listFocusable } from "./useDialogModal";

type Props = {
  /** Change this value to transition to the next view. */
  viewKey: string;
  children: ReactNode;
  className?: string;
};

/** Exit length: the CSS runs it on --motion-panel (styles/theme/tokens.css). */
export const FOCUS_PULL_EXIT_MS = 200;
/** Enter length: the CSS runs it on --motion-state. */
export const FOCUS_PULL_ENTER_MS = 250;

type Transition = {
  outgoingKey: string;
  outgoingChildren: ReactNode;
  incomingKey: string;
  incomingChildren: ReactNode;
  entering: boolean;
};

const ViewContent = memo(
  function ViewContent({ children }: { children: ReactNode; freeze: boolean }) {
    return children;
  },
  (previous, next) => next.freeze || previous.children === next.children,
);

/**
 * Focus-pull view transition: outgoing content fades and blurs for
 * FOCUS_PULL_EXIT_MS, then incoming content fades in and sharpens over
 * FOCUS_PULL_ENTER_MS.
 *
 * The initial view is static. Reduced motion makes the swap immediate,
 * including when that preference changes during a transition.
 *
 * Usage:
 *   <FocusPull viewKey={view}>
 *     {view === "room" ? <Room /> : <Lobby />}
 *   </FocusPull>
 */
export function FocusPull({ viewKey, children, className }: Props) {
  const [transition, setTransition] = useState<Transition | null>(null);
  const [displayed, setDisplayed] = useState({ key: viewKey, children });
  const transitionRef = useRef(transition);
  const displayedKey = useRef(viewKey);
  const displayedChildren = useRef(children);
  const exitDeadline = useRef(0);
  const timers = useRef<number[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);

  const clearTimers = () => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  };

  useLayoutEffect(() => {
    const current = transitionRef.current;
    if (viewKey === (current?.incomingKey ?? displayedKey.current)) {
      if (current) {
        if (current.incomingChildren !== children) {
          const updated = { ...current, incomingChildren: children };
          transitionRef.current = updated;
          setTransition(updated);
        }
      } else {
        displayedChildren.current = children;
      }
      return;
    }

    if (current && !current.entering && viewKey === current.outgoingKey) {
      clearTimers();
      focusNext.current = false;
      displayedChildren.current = children;
      transitionRef.current = null;
      setDisplayed({ key: viewKey, children });
      setTransition(null);
      return;
    }

    focusNext.current =
      Boolean(root.current?.contains(document.activeElement)) ||
      (focusNext.current && document.activeElement === document.body);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      clearTimers();
      displayedKey.current = viewKey;
      displayedChildren.current = children;
      transitionRef.current = null;
      setDisplayed({ key: viewKey, children });
      setTransition(null);
      return;
    }

    clearTimers();
    // The old view stays mounted in its original slot. Once enter begins,
    // the incoming view becomes the outgoing view on interruption.
    const next: Transition = {
      outgoingKey: current?.entering
        ? current.incomingKey
        : (current?.outgoingKey ?? displayedKey.current),
      outgoingChildren: current?.entering
        ? current.incomingChildren
        : (current?.outgoingChildren ?? displayedChildren.current),
      incomingKey: viewKey,
      incomingChildren: children,
      entering: false,
    };
    transitionRef.current = next;
    setTransition(next);

    // A second change during exit shares the original exit deadline. An
    // already fading view must never leave the latest view hidden for a new
    // full exit period. During enter, start the next entrance immediately.
    const exitDelay = current?.entering
      ? 0
      : current
        ? Math.max(0, exitDeadline.current - Date.now())
        : FOCUS_PULL_EXIT_MS;
    exitDeadline.current = Date.now() + exitDelay;
    timers.current.push(
      window.setTimeout(() => {
        const latest = transitionRef.current;
        if (!latest) return;
        const entering = { ...latest, entering: true };
        transitionRef.current = entering;
        setTransition(entering);
        timers.current.push(
          window.setTimeout(() => {
            const finished = transitionRef.current;
            if (!finished) return;
            displayedKey.current = finished.incomingKey;
            displayedChildren.current = finished.incomingChildren;
            transitionRef.current = null;
            setDisplayed({
              key: finished.incomingKey,
              children: finished.incomingChildren,
            });
            setTransition(null);
            timers.current = [];
          }, FOCUS_PULL_ENTER_MS),
        );
      }, exitDelay),
    );
  }, [viewKey, children]);

  useLayoutEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => {
      const current = transitionRef.current;
      if (!event.matches || !current) return;
      clearTimers();
      displayedKey.current = current.incomingKey;
      displayedChildren.current = current.incomingChildren;
      transitionRef.current = null;
      setDisplayed({
        key: current.incomingKey,
        children: current.incomingChildren,
      });
      setTransition(null);
    };
    query?.addEventListener?.("change", onChange);
    return () => {
      query?.removeEventListener?.("change", onChange);
      clearTimers();
    };
  }, []);

  useLayoutEffect(() => {
    if (!focusNext.current || (transition && !transition.entering)) return;
    const active = document.activeElement;
    if (active !== document.body && !root.current?.contains(active)) {
      focusNext.current = false;
      return;
    }
    const slot = root.current?.querySelector(
      transition ? ".focus-pull-enter" : ".focus-pull-current",
    );
    const focusable = slot instanceof HTMLElement ? listFocusable(slot) : [];
    const target =
      focusable.find((element) => element.hasAttribute("autofocus")) ??
      focusable[0];
    (target ?? (slot as HTMLElement | null))?.focus();
    focusNext.current = false;
  }, [transition, displayed.key]);

  const rootClassName = ["focus-pull", className].filter(Boolean).join(" ");

  if (transition) {
    return (
      <div className={rootClassName} ref={root}>
        {/* Inert while it fades: a quick second tap can't land on it. */}
        <div className="focus-pull-exit" inert key={transition.outgoingKey}>
          <ViewContent freeze>{transition.outgoingChildren}</ViewContent>
        </div>
        <div
          className={
            transition.entering ? "focus-pull-enter" : "focus-pull-pending"
          }
          key={transition.incomingKey}
          tabIndex={-1}
        >
          <ViewContent freeze={viewKey !== transition.incomingKey}>
            {viewKey === transition.incomingKey
              ? children
              : transition.incomingChildren}
          </ViewContent>
        </div>
      </div>
    );
  }

  return (
    <div className={rootClassName} ref={root}>
      <div className="focus-pull-current" key={displayed.key} tabIndex={-1}>
        <ViewContent freeze={viewKey !== displayed.key}>
          {viewKey === displayed.key ? children : displayed.children}
        </ViewContent>
      </div>
    </div>
  );
}
