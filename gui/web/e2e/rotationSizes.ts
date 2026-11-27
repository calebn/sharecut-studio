export const ROTATION_SIZES = [
  {
    name: "a width that swaps the phone shell and unmounts the timeline",
    portrait: { width: 390, height: 844 },
    landscape: { width: 844, height: 390 },
    swapsShell: true,
  },
  {
    name: "a width that keeps the phone shell",
    portrait: { width: 375, height: 667 },
    landscape: { width: 667, height: 375 },
    swapsShell: false,
  },
] as const;
