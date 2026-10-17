import { runPointerCommand } from "../commands/pointer";
import { useTabsHeight } from "../hooks/useTabsHeight";
import { BottomTabsSplitterView } from "./BottomTabsSplitterView";

/**
 * Live adapter: `useTabsHeight` owns the `sharecut.tabsHeight` preference and
 * the root `--tabs-height` variable; the view owns the gesture handling.
 * Collapsing runs the same `layout.timeline` command as **Maximize timeline**.
 */
export function BottomTabsSplitter() {
  const { heightRem, setHeightRem, resetHeight, minRem, maxRem, userSet } =
    useTabsHeight();
  return (
    <BottomTabsSplitterView
      heightRem={heightRem}
      minRem={minRem}
      maxRem={maxRem}
      userSet={userSet}
      onResize={setHeightRem}
      onReset={resetHeight}
      onCollapse={() => runPointerCommand("layout.timeline")}
    />
  );
}
