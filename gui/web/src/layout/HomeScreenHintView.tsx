import { Button } from "../ui/Button";
import { HOME_SCREEN_HINT } from "../utils/homeScreenHint";

export function HomeScreenHintView({ onDismiss }: { onDismiss: () => void }) {
  return (
    <aside className="home-screen-hint" aria-label="Full screen">
      <p className="home-screen-hint-text">{HOME_SCREEN_HINT}</p>
      <Button
        variant="link"
        className="home-screen-hint-dismiss"
        onClick={onDismiss}
      >
        Dismiss
      </Button>
    </aside>
  );
}
