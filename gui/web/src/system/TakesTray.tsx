import { useState } from "react";
import { StatusList } from "./StatusList";
import { StatusRow } from "./StatusRow";
import { type TakeInput, takesTrayModel } from "./takesTrayModel";

export type TakesTrayProps = {
  takes: TakeInput[];
  defaultExpanded?: string[];
  onHear?: (takeId: string) => void;
  onRetry?: (takeId: string, personKey: string) => void;
};

export function TakesTray({
  takes,
  defaultExpanded = [],
  onHear,
  onRetry,
}: TakesTrayProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    new Set(defaultExpanded),
  );
  const rows = takesTrayModel(takes);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (rows.length === 0) {
    return (
      <p className="sys-takes-empty">
        No takes yet. Each take you record lands here.
      </p>
    );
  }
  return (
    <div className="sys-takes-tray">
      <StatusList label="Takes">
        {rows.map((row) => (
          <StatusRow
            key={row.id}
            state={row.state}
            title={row.title}
            detail={row.detail}
            progress={row.progress}
            expanded={expanded.has(row.id)}
            onToggle={() => toggle(row.id)}
            action={
              row.hear && onHear
                ? {
                    label: "Hear",
                    name: `Hear ${row.title}`,
                    icon: "ear",
                    onAction: () => onHear(row.id),
                  }
                : undefined
            }
          >
            {row.lines.map((line) => (
              <StatusRow
                key={line.key}
                density="inline"
                state={line.state}
                title={line.name}
                detail={line.detail}
                progress={line.progress}
                barLabel={`${line.name}, ${row.title}`}
                action={
                  line.retry && onRetry
                    ? {
                        label: "Retry",
                        name: `Retry ${line.name}, ${row.title}`,
                        onAction: () => onRetry(row.id, line.key),
                      }
                    : undefined
                }
              />
            ))}
          </StatusRow>
        ))}
      </StatusList>
    </div>
  );
}
