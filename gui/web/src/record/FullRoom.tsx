import { FULL_ROOM_COPY } from "./types";

export function FullRoom() {
  return (
    <main className="cover review-shell record-shell">
      <div className="cover-center center stack">
        <h1>Room full</h1>
        <p>{FULL_ROOM_COPY}</p>
      </div>
    </main>
  );
}
