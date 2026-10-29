import type { SystemIconName } from "../../system/icons";
import { SystemIcon } from "../../system/SystemIcon";
import { Button, Pill } from "../../ui";
import { sortFindings } from "./feedLogic";
import type { Finding, Fix, Severity } from "./feedView";

const GLYPH: Record<Severity, { icon: SystemIconName; word: string }> = {
  blocker: { icon: "octagon-alert", word: "Blocks the feed" },
  warn: { icon: "triangle-alert", word: "Worth fixing" },
  info: { icon: "circle-help", word: "Optional" },
};

type Props = {
  findings: readonly Finding[];
  onFix: (fix: Fix) => void;
};

/** Every finding, closed by default: the readiness strip already leads with the first one. */
export function FeedChecks({ findings, onFix }: Props) {
  if (findings.length === 0) return null;
  const open = findings.filter((f) => f.severity !== "info").length;
  return (
    <details className="fd-checks">
      <summary>
        <SystemIcon name="chevron-down" size={14} />
        <span>Checks</span>
        <span className="fd-checks-count">
          {open === 0 ? "All clear" : `${open} to fix`}
        </span>
      </summary>
      <ul className="fd-findings">
        {sortFindings(findings).map((finding) => {
          const glyph = GLYPH[finding.severity];
          return (
            <li
              key={finding.id}
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
              {finding.fix ? (
                <Button
                  onClick={() => onFix(finding.fix as Fix)}
                  aria-label={`${finding.fix.label}: ${finding.message}`}
                >
                  {finding.fix.label}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
