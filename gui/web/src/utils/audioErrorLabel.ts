/**
 * Short, self-explaining pill label for a transport audio error. The full
 * message stays in the pill's tooltip and accessible name; the label has to
 * make sense on touch, where a tooltip never shows.
 */
export function audioErrorLabel(message: string): string {
  if (/^No premix/i.test(message)) {
    return "No preview";
  }
  if (/^Failed to load audio/i.test(message)) {
    return "Audio failed to load";
  }
  if (/autoplay/i.test(message)) {
    return "Tap Play to start";
  }
  return "Audio error";
}
