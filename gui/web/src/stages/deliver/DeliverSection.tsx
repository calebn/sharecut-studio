import { type ReactNode, useId } from "react";

type Props = {
  title: string;
  action?: ReactNode;
  children: ReactNode;
};

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
