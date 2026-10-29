import { type RefObject, useId, useState } from "react";
import { PersonAvatar } from "../../system/Person";
import { Button, Field } from "../../ui";
import { useDisabledReasonNote } from "../../ui/disabledReason";
import type { ShowState } from "./feedView";

type Props = {
  suggest: Extract<ShowState, { kind: "none" }>["suggest"];
  inputRef: RefObject<HTMLInputElement | null>;
  onCreate: (title: string) => void;
};

/** First run: the show needs a name, and the speakers already told us the rest. */
export function ShowSetup({ suggest, inputRef, onCreate }: Props) {
  const heading = useId();
  const [title, setTitle] = useState("");
  const name = title.trim();
  const reason = useDisabledReasonNote(
    name ? undefined : "Name your show to create it.",
  );
  return (
    <section className="fd-setup" aria-labelledby={heading}>
      <h3 id={heading} className="fd-setup-title">
        Set up your show
      </h3>
      <p className="fd-setup-lead">
        Every episode listing belongs to a show. Name yours and the rest fills
        in as you go.
      </p>
      <dl className="fd-setup-known">
        <div>
          <dt>Language</dt>
          <dd>{suggest.language}</dd>
        </div>
        <div>
          <dt>Hosts</dt>
          <dd>
            <ul className="fd-people">
              {suggest.hosts.map((host) => (
                <li key={host.name} className="fd-person">
                  <PersonAvatar person={host} size={24} />
                  <span className="fd-person-name">{host.name}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
      <form
        className="fd-setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name) onCreate(name);
        }}
      >
        <Field label="Show name" className="fd-setup-field">
          {(control) => (
            <input
              {...control}
              ref={inputRef}
              value={title}
              autoComplete="off"
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="primary"
          disabledReason={name ? undefined : "Name your show to create it."}
          {...reason.describedBy}
        >
          Create
        </Button>
        {reason.note}
      </form>
    </section>
  );
}
