export function ErrorScreen({ message }: { message: string }) {
  return (
    <main className="cover error-screen">
      <div className="cover-center center stack">
        <p className="home-screen-error" role="alert">
          {message}
        </p>
      </div>
    </main>
  );
}
