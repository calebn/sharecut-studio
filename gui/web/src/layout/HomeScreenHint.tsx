import { useState } from "react";
import { Button } from "../ui/Button";
import {
  dismissHomeScreenHint,
  HOME_SCREEN_HINT,
  homeScreenHintDismissed,
  offersHomeScreenHint,
  readHomeScreenEnv,
} from "../utils/homeScreenHint";

/**
 * The shell's Add to Home Screen banner (#1077): in an iPhone or iPad Safari
 * tab, until it is dismissed in that browser. Safari keeps its bars over a
 * web page; the Home Screen app has none.
 */
export function HomeScreenHint() {
  const [shown, setShown] = useState(
    () =>
      offersHomeScreenHint(readHomeScreenEnv()) && !homeScreenHintDismissed(),
  );
  if (!shown) return null;
  return (
    <aside className="home-screen-hint" aria-label="Full screen">
      <p className="home-screen-hint-text">{HOME_SCREEN_HINT}</p>
      <Button
        variant="link"
        className="home-screen-hint-dismiss"
        onClick={() => {
          dismissHomeScreenHint();
          setShown(false);
        }}
      >
        Dismiss
      </Button>
    </aside>
  );
}
