type PitchFlags = HTMLMediaElement & {
  webkitPreservesPitch?: boolean;
  mozPreservesPitch?: boolean;
};

// The prefixed pitch flags cover older WebKit and Gecko.
export function applyElementRate(el: HTMLMediaElement, rate: number): void {
  const media: PitchFlags = el;
  try {
    media.preservesPitch = true;
    media.webkitPreservesPitch = true;
    media.mozPreservesPitch = true;
  } catch {
    // An exotic element still gets its rate below.
  }
  media.defaultPlaybackRate = rate;
  media.playbackRate = rate;
}
