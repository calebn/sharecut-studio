import { useEffect, useId, useRef, useState } from "react";
import type { LanguageOption } from "./whisperLanguages";

type LanguagePickerProps = {
  id: string;
  options: readonly LanguageOption[];
  value: string;
  disabled?: boolean;
  /** True while the setting is held (a step is running): the picker shows, nothing changes. */
  locked?: boolean;
  describedBy?: string;
  onChoose: (value: string) => void;
};

function matches(option: LanguageOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return (
    needle === "" ||
    option.label.toLowerCase().includes(needle) ||
    option.value.toLowerCase() === needle
  );
}

/**
 * A combobox over a listbox. Focus stays in the field; typing narrows the
 * list, the arrow keys move the active language and Enter picks it. Closed, the
 * field reads as the chosen language's name.
 */
export function LanguagePicker({
  id,
  options,
  value,
  disabled = false,
  locked = false,
  describedBy,
  onChoose,
}: LanguagePickerProps) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const chosen = options.find((option) => option.value === value);
  const label = chosen?.label ?? value;
  const shown = options.filter((option) => matches(option, query));
  const current = Math.min(active, Math.max(0, shown.length - 1));
  const activeId =
    open && shown.length > 0 ? `${listId}-${current}` : undefined;

  useEffect(() => {
    if (!open) return;
    document
      .getElementById(`${listId}-${current}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, current, listId]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const choose = (option: LanguageOption | undefined) => {
    close();
    if (option && option.value !== value && !locked) onChoose(option.value);
  };
  const openList = () => {
    if (open) return;
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  };

  return (
    <div
      ref={root}
      className="sys-adv-picker"
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget)) close();
      }}
    >
      <input
        ref={input}
        id={id}
        type="text"
        role="combobox"
        className="sys-adv-select"
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        aria-describedby={describedBy}
        aria-disabled={locked || undefined}
        disabled={disabled}
        value={open ? query : label}
        placeholder={open ? label : undefined}
        onClick={openList}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              openList();
              return;
            }
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive(Math.min(shown.length - 1, Math.max(0, current + step)));
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            choose(shown[current]);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      />
      {open ? (
        <div
          id={listId}
          role="listbox"
          className="sys-adv-options"
          aria-label="Languages"
          tabIndex={-1}
        >
          {shown.length === 0 ? (
            <p className="sys-adv-none">No language matches</p>
          ) : (
            shown.map((option, at) => (
              <div
                key={option.value}
                id={`${listId}-${at}`}
                role="option"
                aria-selected={option.value === value}
                data-active={at === current || undefined}
                className="sys-adv-option"
                tabIndex={-1}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option);
                }}
              >
                {option.label}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
