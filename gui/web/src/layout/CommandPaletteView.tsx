import { useEffect, useState } from "react";
import type { KeymapCategory } from "../keymap/registry";
import { Dialog } from "../ui";
import type {
  CommandPaletteAction,
  CommandPaletteCategory,
} from "./commandPaletteRows";

type TabId = KeymapCategory | "all" | "actions";

export interface CommandPaletteViewProps {
  open: boolean;
  categories: CommandPaletteCategory[];
  unbound: CommandPaletteAction[];
  onClose: () => void;
  onOpenGestures: () => void;
  onRun: (id: string) => void;
  onRemap: (id: string, trimmedKey: string) => void;
}

/**
 * Store-free keyboard shortcuts cheatsheet modal (Figma/Docs/? + Help menu
 * prior art). Open via ? or Transport Menu → Keyboard shortcuts.
 */
export function CommandPaletteView({
  open,
  categories,
  unbound,
  onClose,
  onOpenGestures,
  onRun,
  onRemap,
}: CommandPaletteViewProps) {
  const [tab, setTab] = useState<TabId>("all");
  const [showRemap, setShowRemap] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTab("all");
    setShowRemap(false);
  }, [open]);

  const shown = categories.filter((c) => c.rows.length);

  const visibleCategories =
    tab === "all" || tab === "actions"
      ? shown
      : shown.filter((c) => c.category === tab);

  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <p className="command-palette-hint">
        Press <kbd>?</kbd> anytime. Character keys only apply when the timeline
        or transcript has focus.
      </p>
      <button
        type="button"
        className="ui-control--quiet"
        onClick={onOpenGestures}
      >
        Gestures
      </button>

      <div
        className="command-palette-tabs"
        role="tablist"
        aria-label="Shortcut categories"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "all"}
          className={tab === "all" ? "active" : undefined}
          onClick={() => setTab("all")}
        >
          All keys
        </button>
        {shown.map(({ category }) => (
          <button
            key={category}
            type="button"
            role="tab"
            aria-selected={tab === category}
            className={tab === category ? "active" : undefined}
            onClick={() => setTab(category)}
          >
            {category}
          </button>
        ))}
        {unbound.length ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "actions"}
            className={tab === "actions" ? "active" : undefined}
            onClick={() => setTab("actions")}
          >
            Actions
          </button>
        ) : null}
      </div>

      <div className="command-palette-toolbar">
        <label className="command-palette-remap-toggle">
          <input
            type="checkbox"
            checked={showRemap}
            onChange={(e) => setShowRemap(e.target.checked)}
          />
          Show remaps
        </label>
      </div>

      {tab !== "actions"
        ? visibleCategories.map(({ category, rows }) => (
            <section key={category} className="command-palette-section">
              <h3>{category}</h3>
              <ul>
                {rows.map((row) => (
                  <li key={`${row.id}:${row.shortcut}`}>
                    <button
                      type="button"
                      className="ui-control command-palette-run"
                      onClick={() => onRun(row.id)}
                    >
                      <span>{row.label}</span>
                      <kbd>{row.shortcut}</kbd>
                    </button>
                    {showRemap ? (
                      <label className="command-palette-remap">
                        Remap
                        <input
                          aria-label={`Remap ${row.label}`}
                          placeholder={row.defaultKey}
                          onBlur={(e) => {
                            onRemap(row.id, e.target.value.trim());
                          }}
                        />
                      </label>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))
        : null}

      {tab === "actions" || (tab === "all" && unbound.length) ? (
        <section className="command-palette-section">
          <h3>Commands without keys</h3>
          <ul>
            {unbound.map((action) => (
              <li key={action.id}>
                <button
                  type="button"
                  className="ui-control command-palette-run"
                  onClick={() => onRun(action.id)}
                >
                  <span>{action.label}</span>
                  <kbd>None</kbd>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Dialog>
  );
}
