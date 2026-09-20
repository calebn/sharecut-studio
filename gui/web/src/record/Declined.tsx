import { DECLINED_COPY } from "./types";

export function Declined() {
  return (
    <main className="cover review-shell record-shell">
      <div className="cover-center center stack">
        <h1>You declined</h1>
        <p>{DECLINED_COPY}</p>
      </div>
    </main>
  );
}
