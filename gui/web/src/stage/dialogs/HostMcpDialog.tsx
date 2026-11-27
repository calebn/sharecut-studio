import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { copyText } from "../../record";
import { Button, Dialog, Field, InlineError } from "../../ui";
import { useStableCallback } from "../../utils/useStableCallback";
import {
  type ActivityClass,
  activityClass,
  activityText,
  COPY_FAILED_MESSAGE,
  localHostMcpUrl,
  MCP_SETUP_GUIDE_URL,
  mcpClientSnippet,
  UNAVAILABLE_MESSAGE,
} from "./hostMcp";
import { type HostMcpActivity, useHostMcpActivity } from "./useHostMcpActivity";

const COPIED_MS = 2000;

type CopiedKey = "url" | "snippet";

function selectAll(
  event: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>,
) {
  event.currentTarget.select();
}

type Props = {
  open: boolean;
  onClose: () => void;
  hasProject: boolean;
  /** Fixed URL for previews; the live dialog derives the local host URL. */
  mcpUrl?: string;
  /** Fixed activity answer for previews: shown as is, with no polling. */
  activityPreview?: HostMcpActivity;
};

export function HostMcpDialog({
  open,
  onClose,
  hasProject,
  mcpUrl,
  activityPreview,
}: Props) {
  const [session, setSession] = useState({ open, epoch: 0 });
  const [copied, setCopied] = useState<CopiedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [liveText, setLiveText] = useState("");
  const copyUrlRef = useRef<HTMLButtonElement>(null);
  const unavailableRef = useRef<HTMLParagraphElement>(null);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousClass = useRef<ActivityClass>("unknown");
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  if (session.open !== open) {
    setSession({ open, epoch: session.epoch + 1 });
    if (!open) {
      setCopied(null);
      setError(null);
      setStatus(null);
      setLiveText("");
    }
  }
  const acceptsSession = useStableCallback(
    (epoch: number) => open && session.epoch === epoch,
  );

  const url = mcpUrl ?? localHostMcpUrl();
  const snippet = mcpClientSnippet(url);

  const { activity: shown, now } = useHostMcpActivity({
    open,
    poll: open && mcpUrl === undefined && activityPreview === undefined,
    preview: activityPreview,
  });
  const cls = activityClass(shown, now);
  const unavailable = cls === "unavailable";
  const text = activityText(shown, now);
  const announce = useStableCallback((message: string | null) => {
    if (liveTimer.current) clearTimeout(liveTimer.current);
    setLiveText(message ?? "");
    const epoch = session.epoch;
    liveTimer.current = setTimeout(() => {
      if (acceptsSession(epoch)) setLiveText("");
    }, COPIED_MS);
  });

  useEffect(() => {
    const before = previousClass.current;
    previousClass.current = cls;

    if (unavailable) {
      const active = document.activeElement;
      if (!active || active === document.body) {
        unavailableRef.current?.focus();
      } else if (
        active !== unavailableRef.current &&
        before !== "unknown" &&
        before !== cls
      ) {
        announce(UNAVAILABLE_MESSAGE);
      }
      return;
    }

    if (before !== "unknown" && cls !== "unknown" && before !== cls) {
      announce(text);
    }
  }, [cls, unavailable, announce, text]);

  useEffect(
    () => () => {
      if (liveTimer.current) clearTimeout(liveTimer.current);
    },
    [],
  );

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
    (key: CopiedKey, message: string) => {
      clearCopiedTimer();
      setError(null);
      setCopied(key);
      setStatus(message);
      copiedTimer.current = setTimeout(() => {
        if (!acceptsSession(session.epoch)) return;
        setCopied(null);
        setStatus(null);
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
        markCopied(key, key === "url" ? "Copied address" : "Copied config");
      } catch {
        if (!acceptsSession(session.epoch) || gen !== generation.current) {
          return;
        }
        clearCopiedTimer();
        setCopied(null);
        setStatus(null);
        setError(COPY_FAILED_MESSAGE);
      }
    },
    [markCopied, clearCopiedTimer, session.epoch, acceptsSession],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect agent"
      initialFocusRef={copyUrlRef}
      panelClassName="share-dialog-panel"
      footer={
        unavailable ? undefined : (
          <div className="share-dialog-actions">
            <Button type="button" onClick={() => void copy("snippet", snippet)}>
              {copied === "snippet" ? "Copied" : "Copy config"}
            </Button>
            <Button
              ref={copyUrlRef}
              variant="primary"
              type="button"
              onClick={() => void copy("url", url)}
            >
              {copied === "url" ? "Copied" : "Copy address"}
            </Button>
          </div>
        )
      }
    >
      <div className="share-dialog-body">
        {unavailable ? (
          <p
            ref={unavailableRef}
            className="host-mcp-lead host-mcp-unavailable"
            tabIndex={-1}
          >
            {UNAVAILABLE_MESSAGE}
          </p>
        ) : (
          <>
            <p className="host-mcp-lead">
              Keep ShareCut Studio running while your AI app uses it. The app
              works on the episode you have open.
            </p>
            <ol className="host-mcp-steps">
              <li>Copy the connection address below.</li>
              <li>Paste it into your AI app's MCP or connector settings.</li>
              <li>
                Ask your app to do something in ShareCut. The line below updates
                when it does.
              </li>
            </ol>
            {hasProject ? null : (
              <p className="share-dialog-note" role="status">
                Open an episode first. Your AI app has nothing to work on until
                you do.
              </p>
            )}
            <Field
              label="Connection address"
              hint="The MCP server address for this computer."
            >
              {(control) => (
                <input
                  {...control}
                  className="share-dialog-select"
                  readOnly
                  onFocus={selectAll}
                  onClick={selectAll}
                  value={url}
                />
              )}
            </Field>
          </>
        )}
        <p className="host-mcp-activity">{unavailable ? null : text}</p>
        <p
          className="sr-only host-mcp-activity-live"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {liveText}
        </p>
        {unavailable ? null : (
          <details className="host-mcp-config">
            <summary>Config file format</summary>
            <p>If your app takes a config file instead, use this.</p>
            <Field label="Configuration (JSON)">
              {(control) => (
                <textarea
                  {...control}
                  className="host-mcp-snippet"
                  readOnly
                  onFocus={selectAll}
                  onClick={selectAll}
                  rows={6}
                  value={snippet}
                  spellCheck={false}
                />
              )}
            </Field>
          </details>
        )}
        <p className="host-mcp-guide">
          {unavailable ? null : <span>Not sure where the settings are?</span>}
          <a
            href={MCP_SETUP_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Setup guide (opens in a new tab)
          </a>
        </p>
        <div className="share-dialog-live">
          <p
            className="share-dialog-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {status}
          </p>
          <InlineError message={error} />
        </div>
      </div>
    </Dialog>
  );
}
