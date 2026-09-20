/** Parse a failed fetch Response into a short user-facing message. */
export async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { message?: unknown; detail?: unknown };
    if (typeof body.message === "string" && body.message.trim()) {
      return body.message.trim();
    }
    if (typeof body.detail === "string" && body.detail.trim()) {
      return body.detail.trim();
    }
  } catch {
    // not JSON
  }
  if (/host offline/i.test(text)) {
    return "Host offline — ask them to run podcast tunnel and try again.";
  }
  return text.trim() || `Request failed (${res.status})`;
}
