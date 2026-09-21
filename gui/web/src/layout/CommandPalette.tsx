import { useEffect, useState } from "react";
import { COMMANDS, listCatalogIds } from "../commands/catalog";
import {
  formatShortcutKeys,
  KEYMAP_COMMANDS,
  type KeymapCategory,
  keymapByCategory,
} from "../keymap/registry";
import { clearKeymapOverride, setKeymapOverride } from "../keymap/remaps";
import { useDaw } from "../state/useDaw";
import { CommandButton, Dialog } from "../ui";

const CATEGORY_ORDER: KeymapCategory[] = [
  "transport",
  "tools",
  "focus",
  "navigation",
  "review",
  "history",
  "edit",
  "view",
  "ui",
  "presence",
];

type TabId = KeymapCategory | "all" | "actions";

/**
 * Keyboard shortcuts cheatsheet modal (Figma/Docs/? + Help menu prior art).
 * Open via ? or Transport Menu → Keyboard shortcuts.
 */
export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen, setGesturesSheetOpen } =
    useDaw();
  const [tab, setTab] = useState<TabId>("all");
  const [showRemap, setShowRemap] = useState(false);

  useEffect(() => {
    if (!commandPaletteOpen) {
      return;
    }
    setTab("all");
    setShowRemap(false);
  }, [commandPaletteOpen]);

  const byCat = keymapByCategory();
  const unbound = listCatalogIds().filter(
    (id) => !KEYMAP_COMMANDS.some((k) => k.id === id),
  );

  const visibleCategories =
    tab === "all" || tab === "actions"
      ? CATEGORY_ORDER.filter((c) => (byCat[c] ?? []).length > 0)
      : CATEGORY_ORDER.filter((c) => c === tab);

  return (
    <Dialog
      open={commandPaletteOpen}
      onClose={() => setCommandPaletteOpen(false)}
      title="Keyboard shortcuts"
    >
      <p className="command-palette-hint">
        Press <kbd>?</kbd> anytime. Character keys only apply when the timeline
        (or transcript) is focused — not while typing in a field.
      </p>
      <button
        type="button"
        className="ui-control--quiet"
        onClick={() => {
          setCommandPaletteOpen(false);
          setGesturesSheetOpen(true);
        }}
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
        {CATEGORY_ORDER.filter((c) => (byCat[c] ?? []).length > 0).map(
          (cat) => (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={tab === cat}
              className={tab === cat ? "active" : undefined}
              onClick={() => setTab(cat)}
            >
              {cat}
            </button>
          ),
        )}
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
        ? visibleCategories.map((cat) => {
            const rows = byCat[cat] ?? [];
            if (!rows.length) {
              return null;
            }
            return (
              <section key={cat} className="command-palette-section">
                <h3>{cat}</h3>
                <ul>
                  {rows.map((cmd) => (
                    <li key={`${cmd.id}:${formatShortcutKeys(cmd)}`}>
                      <CommandButton
                        bare
                        commandId={cmd.id}
                        className="command-palette-run"
                      >
                        <span>{cmd.label}</span>
                        <kbd>{formatShortcutKeys(cmd)}</kbd>
                      </CommandButton>
                      {showRemap ? (
                        <label className="command-palette-remap">
                          Remap
                          <input
                            aria-label={`Remap ${cmd.label}`}
                            placeholder={cmd.keys[0]}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (!v) {
                                clearKeymapOverride(cmd.id);
                                return;
                              }
                              setKeymapOverride(cmd.id, [v]);
                            }}
                          />
                        </label>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        : null}

      {tab === "actions" || (tab === "all" && unbound.length) ? (
        <section className="command-palette-section">
          <h3>Commands without keys</h3>
          <ul>
            {unbound.map((id) => (
              <li key={id}>
                <CommandButton
                  bare
                  commandId={id}
                  className="command-palette-run"
                >
                  <span>{COMMANDS[id]?.label ?? id}</span>
                  <kbd>—</kbd>
                </CommandButton>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Dialog>
  );
}
