import type { ReactNode, Ref } from "react";
import type { ShellBreakpoint } from "../../state/types";
import { StatusRow } from "../../system/StatusRow";
import { Button } from "../../ui";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { HostBody } from "./HostBody";
import type { HostState, ReadinessRow } from "./hostModels";

type DeliverAction = {
  label: string;
  onClick: () => void;
  /** Why the control cannot run now; it stays visible and explains itself. */
  disabledReason?: string;
};

export type DeliverStageViewProps = {
  shell: ShellBreakpoint;
  state: HostState;
  failure?: LoadFailure | null;
  summary: string;
  rows: readonly ReadinessRow[];
  onFix: (row: ReadinessRow) => void;
  /** The one filled button on the page. */
  exportAction: DeliverAction;
  /** Absent when the link feature is not on offer. */
  share?: DeliverAction;
  /** Rendered inside the share feature's slot. */
  shareSlot?: (content: ReactNode) => ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
};

/** Deliver: readiness, then the ways out of the project. */
export function DeliverStageView({
  shell,
  state,
  failure,
  summary,
  rows,
  onFix,
  exportAction,
  share,
  shareSlot = (content) => content,
  scrollRef,
}: DeliverStageViewProps) {
  return (
    <HostBody
      stage="deliver"
      shell={shell}
      state={state}
      failure={failure}
      scrollRef={scrollRef}
    >
      <div className="stage-host-page">
        <section
          className="stage-host-section"
          aria-labelledby="deliver-readiness"
        >
          <h2 id="deliver-readiness" className="stage-host-title">
            {summary}
          </h2>
          <ul className="stage-host-list" aria-label="Readiness">
            {rows.map((row) => (
              <li key={row.id}>
                <StatusRow
                  state={row.state}
                  title={row.title}
                  detail={row.detail}
                  action={
                    row.fix
                      ? { label: row.fix.label, onAction: () => onFix(row) }
                      : undefined
                  }
                />
              </li>
            ))}
          </ul>
        </section>
        <section
          className="stage-host-section"
          aria-labelledby="deliver-episode"
        >
          <h2 id="deliver-episode" className="stage-host-title">
            Episode file
          </h2>
          <div className="stage-host-actions">
            <Button
              variant="primary"
              disabledReason={exportAction.disabledReason}
              onClick={exportAction.onClick}
            >
              {exportAction.label}
            </Button>
          </div>
        </section>
        {share
          ? shareSlot(
              <section
                className="stage-host-section"
                aria-labelledby="deliver-listen"
              >
                <h2 id="deliver-listen" className="stage-host-title">
                  Listen link
                </h2>
                <div className="stage-host-actions">
                  <Button
                    disabledReason={share.disabledReason}
                    onClick={share.onClick}
                  >
                    {share.label}
                  </Button>
                </div>
              </section>,
            )
          : null}
      </div>
    </HostBody>
  );
}
