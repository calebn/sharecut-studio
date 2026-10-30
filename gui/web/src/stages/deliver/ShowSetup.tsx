import { useId, useState } from "react";
import { PersonAvatar } from "../../system/Person";
import { Button, Field } from "../../ui";
import { useDisabledReasonNote } from "../../ui/disabledReason";
import { colorIndexOf } from "./feedLogic";
import type { Fix, ShowState } from "./feedView";

type Props = {
  show: Exclude<ShowState, { kind: "ready" }>;
  onAction: (fix: Fix) => void;
};

function NewShow({ onCreate }: { onCreate: (title: string) => void }) {
  const [title, setTitle] = useState("");
  const name = title.trim();
  const why = name ? undefined : "Name your show to create it.";
  const reason = useDisabledReasonNote(why);
  return (
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
            value={title}
            autoComplete="off"
            onChange={(event) => setTitle(event.target.value)}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="primary"
        disabledReason={why}
        {...reason.describedBy}
      >
        Create
      </Button>
      {reason.note}
    </form>
  );
}

/** First run: the show needs a name, or one of the shows you have. The speakers already told us the rest. */
export function ShowSetup({ show, onAction }: Props) {
  const heading = useId();
  const [adding, setAdding] = useState(false);
  const create = (title: string) =>
    onAction({ kind: "command", command: "create_show", args: { title } });
  if (show.kind === "choose") {
    return (
      <section className="fd-setup" aria-labelledby={heading}>
        <h3 id={heading} className="fd-setup-title">
          Which show is this episode in?
        </h3>
        <ul className="fd-shows">
          {show.shows.map((one) => (
            <li key={one.id}>
              <Button
                onClick={() =>
                  onAction({
                    kind: "command",
                    command: "link_show",
                    args: { id: one.id },
                  })
                }
              >
                {one.title}
              </Button>
            </li>
          ))}
          {adding ? null : (
            <li>
              <Button variant="link" onClick={() => setAdding(true)}>
                New show
              </Button>
            </li>
          )}
        </ul>
        {adding ? <NewShow onCreate={create} /> : null}
      </section>
    );
  }
  const { suggest } = show;
  return (
    <section className="fd-setup" aria-labelledby={heading}>
      <h3 id={heading} className="fd-setup-title">
        Set up your show
      </h3>
      <p className="fd-setup-lead">Name it and the rest fills in as you go.</p>
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
                  <PersonAvatar
                    person={{
                      name: host.name,
                      colorIndex: colorIndexOf(host.name),
                    }}
                    size={24}
                  />
                  <span className="fd-person-name">{host.name}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
      <NewShow onCreate={create} />
    </section>
  );
}

/** Someone on a link cannot create or choose the show, so they are told who can instead of shown the form. */
export function ShowHostNote({ show }: { show: Props["show"] }) {
  return (
    <section className="fd-setup" aria-label="Show setup">
      <p className="fd-setup-lead">
        {show.kind === "choose"
          ? "The host picks which show this episode is in."
          : "The show is not set up yet. Its values appear once the host sets it up."}
      </p>
    </section>
  );
}
