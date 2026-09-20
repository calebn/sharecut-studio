export function LoadingScreen({ label = "Loading…" }: { label?: string }) {
  return (
    <main className="cover loading-screen">
      <div className="cover-center center stack">
        <p>{label}</p>
      </div>
    </main>
  );
}
