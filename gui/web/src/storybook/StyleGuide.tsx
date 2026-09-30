import { useId, useState } from "react";
import { Button, Field, ToggleButton } from "../ui";
import "./style-guide.css";

const CATALOG = [
  {
    label: "Colors and surfaces",
    id: "atoms-surfaceladder--docs",
    use: "Choose a surface and its matching text role.",
  },
  {
    label: "Buttons",
    id: "atoms-button--docs",
    use: "Choose primary, default, danger, or link treatment.",
  },
  {
    label: "Fields",
    id: "molecules-field--docs",
    use: "Keep labels, hints, and errors close to their control.",
  },
  {
    label: "Dialogs",
    id: "organisms-dialog--docs",
    use: "Use the shared modal behavior and scrolling body.",
  },
  {
    label: "Bounce dialog",
    id: "templates-bouncedialog--docs",
    use: "See aligned controls and section spacing in a real task.",
  },
  {
    label: "Menus",
    id: "molecules-menu--docs",
    use: "Check grouping, focus, and keyboard navigation.",
  },
] as const;

const SPACING = [
  { token: "--space-0", use: "Small optical offsets" },
  { token: "--space-1", use: "Tight relationships" },
  { token: "--space-3", use: "Related controls and compact insets" },
  { token: "--space-4", use: "Control-to-label gaps and small groups" },
  { token: "--space-5", use: "Panel insets" },
  { token: "--space-6", use: "Separate task sections" },
] as const;

const TYPE = [
  {
    token: "--font-size-heading",
    label: "Heading",
    sample: "Prepare your episode",
  },
  {
    token: "--font-size-review",
    label: "Reading body",
    sample: "Review the conversation before sharing it.",
  },
  {
    token: "--font-size-body",
    label: "Dialog body",
    sample: "Choose the tracks to bounce.",
  },
  {
    token: "--font-size-ui",
    label: "Editor controls",
    sample: "Entire mix · Selected tracks · Soloed tracks",
  },
  {
    token: "--font-size-caption",
    label: "Supporting labels",
    sample: "No session region set",
  },
] as const;

export function StyleGuide() {
  const fieldId = useId();
  const [selected, setSelected] = useState(false);
  const [saved, setSaved] = useState(false);
  const [quietSelected, setQuietSelected] = useState(false);
  return (
    <article className="style-guide" aria-labelledby="style-guide-title">
      <header className="style-guide-intro">
        <h1 id="style-guide-title">Sharecut Studio style guide</h1>
        <p>
          A calm place to listen, record, and edit. Use this guide to choose the
          right pattern, then inspect its live states.
        </p>
        <nav aria-label="Style guide sections">
          <a href="#guide-patterns">Find a pattern</a>
          <a href="#guide-type">Type</a>
          <a href="#guide-space">Spacing</a>
          <a href="#guide-states">Control states</a>
          <a href="#guide-rules">Design rules</a>
        </nav>
      </header>

      <section id="guide-patterns" aria-labelledby="guide-patterns-title">
        <h2 id="guide-patterns-title">Start with the task</h2>
        <p>
          The catalog uses production components. Open a pattern and compare its
          normal, disabled, error, and phone examples where available.
        </p>
        <ul className="style-guide-patterns">
          {CATALOG.map(({ label, id, use }) => (
            <li key={id}>
              <a href={`./?path=/docs/${id}`} target="_top">
                {label}
              </a>
              <span>{use}</span>
            </li>
          ))}
        </ul>
      </section>

      <section id="guide-type" aria-labelledby="guide-type-title">
        <h2 id="guide-type-title">Give each size a job</h2>
        <p>
          Reading surfaces use a larger body size than the editor. Keep the
          mixing room compact; give dialogs and reading pages room to read.
        </p>
        <dl className="style-guide-samples">
          {TYPE.map(({ token, label, sample }) => (
            <div key={token}>
              <dt>
                {label}
                <code>{token}</code>
              </dt>
              <dd style={{ fontSize: `var(${token})` }}>{sample}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="guide-space" aria-labelledby="guide-space-title">
        <h2 id="guide-space-title">Group tightly, separate deliberately</h2>
        <p>
          Use smaller gaps within a choice and larger gaps between task
          sections. These samples read the current theme tokens directly.
        </p>
        <dl className="style-guide-samples">
          {SPACING.map(({ token, use }) => (
            <div key={token}>
              <dt>
                <code>{token}</code>
                <span>{use}</span>
              </dt>
              <dd>
                <span
                  className="style-guide-space"
                  style={{ inlineSize: `var(${token})` }}
                  aria-hidden="true"
                />
              </dd>
            </div>
          ))}
        </dl>
        <p>
          In Bounce, control rows share an input/text alignment. The Source
          group, export options, and footer are separated with{" "}
          <code>--space-6</code>; labels have a <code>--touch-min</code> minimum
          target.
        </p>
      </section>

      <section id="guide-states" aria-labelledby="guide-states-title">
        <h2 id="guide-states-title">Actions and selections look different</h2>
        <p>
          Accent marks the primary action. A neutral chip marks a selected mode.
          Quiet tabs use an underline; grouped segments keep the chip. Hover and
          keyboard focus remain distinct from selection.
        </p>
        <div className="style-guide-control-row">
          <Button variant="primary" onClick={() => setSaved(true)}>
            Save example
          </Button>
          <ToggleButton
            pressed={selected}
            onClick={() => setSelected(!selected)}
          >
            Select example
          </ToggleButton>
          <Button disabled>Unavailable</Button>
          <ToggleButton
            quiet
            pressed={quietSelected}
            onClick={() => setQuietSelected(!quietSelected)}
          >
            Quiet tab example
          </ToggleButton>
        </div>
        <p role="status" className="style-guide-feedback">
          {saved
            ? "Example saved. No project data changed."
            : "Try the controls, or use Tab to inspect their focus rings."}
        </p>
        <Field
          label="Episode name"
          htmlFor={fieldId}
          hintId={`${fieldId}-hint`}
          hint="A label identifies the control; a hint adds useful context."
        >
          <input
            id={fieldId}
            aria-describedby={`${fieldId}-hint`}
            defaultValue="Field notes"
          />
        </Field>
      </section>

      <section id="guide-rules" aria-labelledby="guide-rules-title">
        <h2 id="guide-rules-title">Use the right source</h2>
        <p>
          Change token values in their owning CSS files. This guide illustrates
          current patterns; the linked rules explain constraints and intended
          behavior.
        </p>
        <ul className="style-guide-patterns">
          <li>
            <a href="https://github.com/calebn/sharecut-studio/blob/main/docs/design-tokens.md">
              Token naming and ownership
            </a>
            <span>
              Primitive, semantic, and component roles; light and dark themes.
            </span>
          </li>
          <li>
            <a href="https://ux.sharecut.studio/#/brand">
              Brand and styling guidance
            </a>
            <span>
              Reading and mixing rooms, color roles, control states, and units.
            </span>
          </li>
          <li>
            <a href="https://github.com/calebn/sharecut-studio/blob/main/gui/web/docs/ui-library.md">
              Component library contract
            </a>
            <span>
              Shared controls, overlays, command wiring, and accessibility.
            </span>
          </li>
          <li>
            <a href="https://github.com/calebn/sharecut-studio/blob/main/docs/ui-philosophy.md">
              Beta UI requirements
            </a>
            <span>
              Trust, review, undo, and recovery. Requirements do not prove a
              feature has shipped.
            </span>
          </li>
        </ul>
        <p>
          Before a component change is ready, check both themes, a narrow view,
          long copy, keyboard order, and error or disabled states. Run focused
          tests and accessibility checks.
        </p>
      </section>
    </article>
  );
}
