import { CoverScreen } from "./CoverScreen";

type Props = {
  /** What went wrong. */
  message: string;
  /** What to do next, when the person looking at the screen can act. */
  hint?: string;
};

export function ErrorScreen({ message, hint }: Props) {
  return (
    <CoverScreen shellClassName="error-screen">
      <div className="stack tight" role="alert">
        <p className="home-screen-error">{message}</p>
        {hint && <p className="lede">{hint}</p>}
      </div>
    </CoverScreen>
  );
}
