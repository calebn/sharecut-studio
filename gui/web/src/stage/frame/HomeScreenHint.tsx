import { useState } from "react";
import {
  dismissHomeScreenHint,
  homeScreenHintDismissed,
  offersHomeScreenHint,
  readHomeScreenEnv,
} from "../../utils/homeScreenHint";
import { HomeScreenHintView } from "./HomeScreenHintView";

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
    <HomeScreenHintView
      onDismiss={() => {
        dismissHomeScreenHint();
        setShown(false);
      }}
    />
  );
}
