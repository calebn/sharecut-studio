import { CoverScreen } from "./CoverScreen";

export function LoadingScreen({ label = "Loading…" }: { label?: string }) {
  return (
    <CoverScreen shellClassName="loading-screen">
      <p>{label}</p>
    </CoverScreen>
  );
}
