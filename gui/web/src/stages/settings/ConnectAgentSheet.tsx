import { useEffect, useRef, useState } from "react";
import { Sheet } from "../../system/Sheet";
import { StatusRow } from "../../system/StatusRow";
import {
  Button,
  Field,
  InlineError,
  SegmentedControl,
  ToggleButton,
} from "../../ui";
import {
  AGENT_CLIENTS,
  type AgentClient,
  NO_EPISODE,
  NOT_CONNECTED,
  pasteBlock,
} from "./connectAgent";

const COPIED_MS = 2000;

export type ConnectAgentSheetProps = {
  form: "centered" | "bottom";
  open: boolean;
  onClose: () => void;
  url: string;
  hasProject: boolean;
  /** The agent that joined, by name, once one has. */
  connected: string | null;
  defaultClient?: AgentClient;
  onCopy: (text: string) => Promise<void>;
  /** Goes to the Recent list: where an episode is opened. */
  onOpenRecent: () => void;
};

/** Connect agent: pick the client, copy what it needs, watch for it to join. */
export function ConnectAgentSheet(props: ConnectAgentSheetProps) {
  return props.open ? <OpenSheet {...props} /> : null;
}

function OpenSheet({
  form,
  open,
  onClose,
  url,
  hasProject,
  connected,
  defaultClient = "claude",
  onCopy,
  onOpenRecent,
}: ConnectAgentSheetProps) {
  const [client, setClient] = useState<AgentClient>(defaultClient);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const block = pasteBlock(client, url);
  useEffect(
    () => () => void (timer.current && clearTimeout(timer.current)),
    [],
  );
  const copy = () => {
    setFailure(null);
    onCopy(block.text).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => setFailure("Couldn't copy. Select the text and copy it."),
    );
  };
  return (
    <Sheet
      form={form}
      open={open}
      title="Connect agent"
      detent="half"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      }
    >
      <SegmentedControl label="Client">
        {AGENT_CLIENTS.map((option) => (
          <ToggleButton
            key={option.id}
            quiet
            pressed={client === option.id}
            onClick={() => {
              setClient(option.id);
              setCopied(false);
            }}
          >
            {option.label}
          </ToggleButton>
        ))}
      </SegmentedControl>
      <Field label={block.label}>
        {(control) => (
          <textarea
            {...control}
            className="set-block"
            readOnly
            rows={block.rows}
            value={block.text}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
      </Field>
      <InlineError message={failure} />
      {hasProject ? (
        <StatusRow
          density="inline"
          state={connected ? "done" : "queued"}
          title={connected ? `Connected: ${connected}` : NOT_CONNECTED}
        />
      ) : (
        <p className="set-line" role="status">
          {NO_EPISODE}{" "}
          <button type="button" className="sys-text-btn" onClick={onOpenRecent}>
            Recent
          </button>
        </p>
      )}
    </Sheet>
  );
}
