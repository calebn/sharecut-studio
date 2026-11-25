/** A story's `beforeEach`: the root text at 32 px (200%) until the story ends. */
export const largeText = () => {
  const root = document.documentElement;
  const before = root.style.fontSize;
  root.style.fontSize = "32px";
  return () => {
    root.style.fontSize = before;
  };
};
