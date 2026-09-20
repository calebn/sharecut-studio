import type { ReactNode } from "react";

export function DefinitionList({ children }: { children: ReactNode }) {
  return <dl className="definition-list">{children}</dl>;
}

export function DefItem({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
