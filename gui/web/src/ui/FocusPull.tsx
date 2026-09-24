import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

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

/**
 * Focus-pull view transition: outgoing content fades and blurs for
 * FOCUS_PULL_EXIT_MS, then incoming content fades in and sharpens over
 * FOCUS_PULL_ENTER_MS.
 *
 * The initial view is static. CSS makes reduced motion an instant visual cut,
 * without making this component depend on a JavaScript media-query listener.
 *
 * Usage:
 *   <FocusPull viewKey={view}>
 *     {view === "room" ? <Room /> : <Lobby />}
 *   </FocusPull>
 */
export function FocusPull({ viewKey, children, className }: Props) {
  const [transition, setTransition] = useState<{
    outgoing: ReactNode;
    entering: boolean;
  } | null>(null);
  const displayedKey = useRef(viewKey);
  const displayedChildren = useRef(children);

  useLayoutEffect(() => {
    if (viewKey === displayedKey.current) {
      setTransition(null);
      return;
    }

    setTransition({ outgoing: displayedChildren.current, entering: false });
    let finish: number | undefined;
    const enter = window.setTimeout(() => {
      setTransition((current) =>
        current ? { ...current, entering: true } : current,
      );
      // Timed from the enter phase, so a stalled main thread still gives
      // the incoming view its full fade.
      finish = window.setTimeout(() => {
        displayedKey.current = viewKey;
        setTransition(null);
      }, FOCUS_PULL_ENTER_MS);
    }, FOCUS_PULL_EXIT_MS);

    return () => {
      window.clearTimeout(enter);
      window.clearTimeout(finish);
    };
  }, [viewKey]);

  useLayoutEffect(() => {
    if (viewKey === displayedKey.current) {
      displayedChildren.current = children;
    }
  }, [children, viewKey]);

  const rootClassName = ["focus-pull", className].filter(Boolean).join(" ");

  if (transition) {
    return (
      <div className={rootClassName}>
        {/* Inert while it fades: a quick second tap can't land on it. */}
        <div className="focus-pull-exit" inert>
          {transition.outgoing}
        </div>
        <div
          className={
            transition.entering ? "focus-pull-enter" : "focus-pull-pending"
          }
        >
          {children}
        </div>
      </div>
    );
  }

  return <div className={rootClassName}>{children}</div>;
}
