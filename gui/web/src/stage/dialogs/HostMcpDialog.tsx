import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../../record";
import { Button, Dialog, Field, InlineError } from "../../ui";
import { errorMessage } from "../../utils/apiError";
import { useStableCallback } from "../../utils/useStableCallback";
import { localHostMcpUrl, mcpClientSnippet } from "./hostMcp";

const COPIED_MS = 2000;

type CopiedKey = "url" | "snippet";

type Props = {
  open: boolean;
  onClose: () => void;
  hasProject: boolean;
  /** Fixed URL for previews; the live dialog derives the local host URL. */
  mcpUrl?: string;
};

export function HostMcpDialog({ open, onClose, hasProject, mcpUrl }: Props) {
  const [session, setSession] = useState({ open, epoch: 0 });
  const [copied, setCopied] = useState<CopiedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  if (session.open !== open) {
    setSession({ open, epoch: session.epoch + 1 });
    if (!open) {
      setCopied(null);
      setError(null);
      setStatus(null);
    }
  }
  const acceptsSession = useStableCallback(
    (epoch: number) => open && session.epoch === epoch,
  );

  const url = mcpUrl ?? localHostMcpUrl();
  const snippet = mcpClientSnippet(url);

  const clearCopiedTimer = useCallback(() => {
    if (copiedTimer.current) {
      clearTimeout(copiedTimer.current);
      copiedTimer.current = null;
    }
  }, []);

  useEffect(() => () => clearCopiedTimer(), [clearCopiedTimer]);

  useEffect(() => {
    if (open) {
      return;
    }
    generation.current += 1;
    clearCopiedTimer();
  }, [open, clearCopiedTimer]);

  const markCopied = useCallback(
    (key: CopiedKey) => {
      clearCopiedTimer();
      setCopied(key);
      copiedTimer.current = setTimeout(() => {
        if (acceptsSession(session.epoch)) setCopied(null);
      }, COPIED_MS);
    },
    [clearCopiedTimer, session.epoch, acceptsSession],
  );

  const copy = useCallback(
    async (key: CopiedKey, text: string) => {
      const gen = generation.current;
      setError(null);
      setStatus(null);
      try {
        await copyText(text);
        if (!acceptsSession(session.epoch) || gen !== generation.current) {
          return;
        }
        markCopied(key);
        setStatus(key === "url" ? "Copied MCP URL" : "Copied client snippet");
      } catch (err) {
        if (!acceptsSession(session.epoch) || gen !== generation.current) {
          return;
        }
        setError(errorMessage(err));
      }
    },
    [markCopied, session.epoch, acceptsSession],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect agent"
      panelClassName="share-dialog-panel"
      footer={
        <div className="share-dialog-actions">
          <Button type="button" onClick={() => void copy("snippet", snippet)}>
            {copied === "snippet" ? "Copied" : "Copy snippet"}
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={() => void copy("url", url)}
          >
            {copied === "url" ? "Copied" : "Copy URL"}
          </Button>
        </div>
      }
    >
      <div className="share-dialog-body">
        <p className="host-mcp-lead">
          Keep ShareCut Studio running. Paste this URL into Cursor or Claude.
          The connection works like Figma desktop MCP. Tools apply to the open
          episode.
        </p>
        {hasProject ? null : (
          <p className="share-dialog-note" role="status">
            Open an episode first; tools error until a project is open.
          </p>
        )}
        <Field label="MCP URL">
          {(control) => (
            <input
              {...control}
              className="share-dialog-select"
              readOnly
              value={url}
            />
          )}
        </Field>
        <Field label="Cursor snippet">
          {(control) => (
            <textarea
              {...control}
              className="host-mcp-snippet"
              readOnly
              rows={8}
              value={snippet}
              spellCheck={false}
            />
          )}
        </Field>
        <div className="share-dialog-live" aria-live="polite">
          {error ? <InlineError message={error} /> : null}
          {status && !error ? (
            <p className="share-dialog-status">{status}</p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
