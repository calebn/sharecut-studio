import type { ReactNode } from "react";

type CoverScreenProps = {
  children: ReactNode;
  heading?: string;
  shellClassName?: string;
};

/** Full-viewport shell for loading, error, and entry screens. */
export function CoverScreen({
  children,
  heading,
  shellClassName,
}: CoverScreenProps) {
  return (
    <main className={`cover${shellClassName ? ` ${shellClassName}` : ""}`}>
      <div className="cover-center center stack">
        {heading && <h1>{heading}</h1>}
        {children}
      </div>
    </main>
  );
}
