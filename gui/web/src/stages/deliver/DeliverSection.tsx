import { type ReactNode, useId } from "react";

type Props = {
  title: string;
  /** A control at the end of the heading row. */
  action?: ReactNode;
  children: ReactNode;
};

/** A titled block of the Deliver page. */
export function DeliverSection({ title, action, children }: Props) {
  const id = useId();
  return (
    <section className="dv-section" aria-labelledby={id}>
      <header className="dv-section-head">
        <h2 id={id} className="dv-section-title">
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}
