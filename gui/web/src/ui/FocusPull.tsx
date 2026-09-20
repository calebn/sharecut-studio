import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

type Props = {
  /** Change this value to transition to the next view. */
  viewKey: string;
  children: ReactNode;
  className?: string;
};

/**
 * Focus-pull view transition: outgoing content fades and blurs for 200ms,
 * then incoming content fades in and sharpens over 250ms.
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
    const enter = window.setTimeout(() => {
      setTransition((current) =>
        current ? { ...current, entering: true } : current,
      );
    }, 200);
    const finish = window.setTimeout(() => {
      displayedKey.current = viewKey;
      setTransition(null);
    }, 450);

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
        <div className="focus-pull-exit">{transition.outgoing}</div>
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
