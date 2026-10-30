import type { RecordSessionSummary } from "../../record";

const DATE = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function heading({ number, ended_at }: RecordSessionSummary): string {
  const name = number === null ? "Last session" : `Session ${number}`;
  const when = ended_at ? new Date(ended_at) : null;
  return when && !Number.isNaN(when.getTime())
    ? `${name} · ${DATE.format(when)}`
    : name;
}

function takesLine({ takes }: RecordSessionSummary): string {
  if (takes.length === 0) {
    return "No takes";
  }
  const total = takes.reduce((sum, t) => sum + t.recording_ms, 0);
  return `${takes.length} ${takes.length === 1 ? "take" : "takes"} · ${clock(total)}`;
}

export type EndedSessionCardProps = {
  session: RecordSessionSummary;
  trackNames: ReadonlyMap<string, string>;
};

export function EndedSessionCard({
  session,
  trackNames,
}: EndedSessionCardProps) {
  return (
    <section
      className="stage-host-section stage-host-record-empty"
      aria-labelledby="record-last-session"
    >
      <h2 id="record-last-session" className="stage-host-title">
        {heading(session)}
      </h2>
      <p className="stage-host-note">{takesLine(session)}</p>
      <ul className="stage-host-list">
        {session.participants.map((p) => {
          const name = p.display_name.trim() || "Guest";
          const target = !session.landed
            ? null
            : p.track_id === null
              ? "New track"
              : (trackNames.get(p.track_id) ?? "Track removed");
          return (
            <li key={p.participant_id} className="stage-host-note">
              {name}
              {target === null ? null : (
                <>
                  {" "}
                  <span aria-hidden="true">→</span>
                  <span className="sr-only"> to</span> {target}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
