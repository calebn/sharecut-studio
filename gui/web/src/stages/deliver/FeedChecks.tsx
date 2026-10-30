import type { SystemIconName } from "../../system/icons";
import { SystemIcon } from "../../system/SystemIcon";
import type { Finding, Fix, Severity } from "../../types/feedView";
import { Button, Pill } from "../../ui";
import { fixLabel, sortFindings } from "./feedLogic";

const GLYPH: Record<Severity, { icon: SystemIconName; word: string }> = {
  blocker: { icon: "octagon-alert", word: "Blocks the feed" },
  warn: { icon: "triangle-alert", word: "Worth fixing" },
  info: { icon: "circle-help", word: "Optional" },
};

type Props = {
  findings: readonly Finding[];
  summary: string;
  onFix: (fix: Fix) => void;
  /** Why a fix is not this link's to run, or null. Without it every fix runs. */
  blockOf?: (fix: Fix) => string | null;
  /** A link that can only read shows the findings without buttons. */
  readOnly?: boolean;
};

/** Every finding, closed by default: the readiness strip already leads with the first one. */
export function FeedChecks({
  findings,
  summary,
  onFix,
  blockOf,
  readOnly = false,
}: Props) {
  if (findings.length === 0) return null;
  return (
    <details className="fd-checks">
      <summary>
        <SystemIcon name="chevron-down" size={14} />
        <span>Checks</span>
        <span className="fd-checks-count">{summary}</span>
      </summary>
      <ul className="fd-findings">
        {sortFindings(findings).map((finding, at) => {
          const glyph = GLYPH[finding.severity];
          const fix = readOnly ? null : finding.fix;
          return (
            <li
              key={`${finding.key}-${at}`}
              className="fd-finding"
              data-severity={finding.severity}
            >
              <SystemIcon name={glyph.icon} size={16} title={glyph.word} />
              <span className="fd-finding-text">{finding.message}</span>
              {finding.platform ? (
                <Pill title={`Matters for ${finding.platform}`}>
                  {finding.platform}
                </Pill>
              ) : null}
              {fix ? (
                <Button
                  className="fd-finding-fix"
                  disabledReason={blockOf?.(fix) ?? undefined}
                  onClick={() => onFix(fix)}
                  aria-label={`${fixLabel(fix)}: ${finding.message}`}
                >
                  {fixLabel(fix)}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
