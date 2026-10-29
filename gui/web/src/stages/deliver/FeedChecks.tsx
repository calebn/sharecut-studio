import type { SystemIconName } from "../../system/icons";
import { SystemIcon } from "../../system/SystemIcon";
import { Button, Pill } from "../../ui";
import { fixLabel, sortFindings } from "./feedLogic";
import type { Finding, Fix, Severity } from "./feedView";

const GLYPH: Record<Severity, { icon: SystemIconName; word: string }> = {
  blocker: { icon: "octagon-alert", word: "Blocks the feed" },
  warn: { icon: "triangle-alert", word: "Worth fixing" },
  info: { icon: "circle-help", word: "Optional" },
};

type Props = {
  findings: readonly Finding[];
  summary: string;
  onFix: (fix: Fix) => void;
};

/** Every finding, closed by default: the readiness strip already leads with the first one. */
export function FeedChecks({ findings, summary, onFix }: Props) {
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
          const fix = finding.fix;
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
