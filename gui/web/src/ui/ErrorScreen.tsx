import { CoverScreen } from "./CoverScreen";

export function ErrorScreen({ message }: { message: string }) {
  return (
    <CoverScreen shellClassName="error-screen">
      <p className="home-screen-error" role="alert">
        {message}
      </p>
    </CoverScreen>
  );
}
