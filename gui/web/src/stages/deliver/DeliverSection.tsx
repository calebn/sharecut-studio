import { type ReactNode, type Ref, useId } from "react";

type Props = {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
};

export function DeliverSection({ title, action, children, headingRef }: Props) {
  const id = useId();
  return (
    <section className="dv-section" aria-labelledby={id}>
      <header className="dv-section-head">
        <h2
          ref={headingRef}
          id={id}
          className="dv-section-title"
          tabIndex={headingRef ? -1 : undefined}
        >
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}
