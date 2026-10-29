import { copyText } from "../../record/recordLinks";

/**
 * Copies text that is not known yet, such as a link still being made, from a
 * click. Call it in the click handler before awaiting anything: with
 * `ClipboardItem` the write starts now, inside the click, and takes the text
 * when it arrives, so Safari and Chrome still count it as a user gesture.
 * Without `ClipboardItem` it waits for the text and then writes it, which a
 * browser that insists on a fresh gesture may refuse; the caller then shows the
 * link for a manual copy.
 *
 * Rejects when the text promise rejects or the browser refuses the write.
 */
export function copyWhenReady(text: Promise<string>): Promise<void> {
  const clipboard =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard?.write && typeof ClipboardItem !== "undefined") {
    const blob = text.then(
      (value) => new Blob([value], { type: "text/plain" }),
    );
    return clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  }
  return text.then(copyText);
}
