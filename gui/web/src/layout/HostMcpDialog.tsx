import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Dialog, Field, InlineError } from "../ui";
import { errorMessage } from "../utils/apiError";
import { localHostMcpUrl, mcpClientSnippet } from "./hostMcp";

const COPIED_MS = 2000;

type CopiedKey = "url" | "snippet";

type Props = {
  open: boolean;
  onClose: () => void;
  hasProject: boolean;
};

async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard unavailable");
  }
  await navigator.clipboard.writeText(text);
}

export function HostMcpDialog({ open, onClose, hasProject }: Props) {
  const urlId = useId();
  const snippetId = useId();
  const [copied, setCopied] = useState<CopiedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);

  const url = localHostMcpUrl();
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
    setCopied(null);
    setError(null);
    setStatus(null);
  }, [open, clearCopiedTimer]);

  const markCopied = useCallback(
    (key: CopiedKey) => {
      clearCopiedTimer();
      setCopied(key);
      copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
    },
    [clearCopiedTimer],
  );

  const copy = useCallback(
    async (key: CopiedKey, text: string) => {
      const gen = generation.current;
      setError(null);
      setStatus(null);
      try {
        await copyText(text);
        if (gen !== generation.current) {
          return;
        }
        markCopied(key);
        setStatus(key === "url" ? "Copied MCP URL" : "Copied client snippet");
      } catch (err) {
        if (gen !== generation.current) {
          return;
        }
        setError(errorMessage(err));
      }
    },
    [markCopied],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect agent"
      panelClassName="share-dialog-panel"
    >
      <div className="share-dialog-body">
        <p className="host-mcp-lead">
          Keep Sharecut Studio running. Paste this URL into Cursor or Claude.
          The connection works like Figma desktop MCP. Tools apply to the open
          episode.
        </p>
        {hasProject ? null : (
          <p className="share-dialog-empty" role="status">
            Open an episode first; tools error until a project is open.
          </p>
        )}
        <Field label="MCP URL" htmlFor={urlId}>
          <input
            id={urlId}
            className="share-dialog-select"
            readOnly
            value={url}
          />
        </Field>
        <div className="share-dialog-actions">
          <Button
            variant="primary"
            type="button"
            onClick={() => void copy("url", url)}
          >
            {copied === "url" ? "Copied" : "Copy URL"}
          </Button>
        </div>
        <Field label="Cursor snippet" htmlFor={snippetId}>
          <textarea
            id={snippetId}
            className="host-mcp-snippet"
            readOnly
            rows={8}
            value={snippet}
            spellCheck={false}
          />
        </Field>
        <div className="share-dialog-actions">
          <Button type="button" onClick={() => void copy("snippet", snippet)}>
            {copied === "snippet" ? "Copied" : "Copy snippet"}
          </Button>
        </div>
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
