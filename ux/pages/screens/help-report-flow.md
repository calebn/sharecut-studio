## Help report flow (Home and Studio host)

Help creates a local diagnostics ZIP, then shows its path, size, file list, and
app version before any upload. The user writes a description and, when a report
relay is configured, explicitly accepts that the description and ZIP become
public. The ZIP link lasts 30 days. The ZIP is scrubbed on this computer before it can leave: it holds no share-link token, because tokens are masked by route path and by value. Submit shows queued status, then the
published issue link and completed message when available. A submitted bundle cannot be submitted
again; creating another bundle clears the prior publication link. An uncertain
publication asks the user to check status later, and a failed publication
directs them to the local ZIP and support. Late responses from a closed or
replaced Help dialog do not restore the prior report. Open support pre-fills the GitHub bug form
with the description and version for the self-hosted/manual path; the user
attaches the local ZIP there. Guests never see these controls.
