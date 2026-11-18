/**
 * What the bar at develop (44ce1acd4) showed at each width, as the controls it
 * drew and which pills had their text or their detail, for the states it laid
 * out without overlap. A band is [from, to, signature] in px at the default
 * text size; signature is the controls, then "|t:" the pills with their text,
 * then "|d:" the pills with their detail. The bar must keep showing exactly
 * that wherever develop had no overlap, bar the short windows SHOWS_LESS names
 * in system.spec.ts: it gives a control up only when the control did not fit.
 * Widths where develop overlapped are not listed; there the bar only has to be
 * clean.
 */
export type Band = readonly [from: number, to: number, shown: string];
export type Baseline = Record<"fine" | "coarse", readonly Band[]>;

export const BASELINE: Record<string, Baseline> = {
  plain: {
    fine: [
      [396, 640, "A/B,comment,cuts,hear options,play,time"],
      [
        644,
        1400,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,time",
      ],
    ],
    coarse: [
      [396, 640, "A/B,comment,cuts,hear options,play,time"],
      [
        652,
        1400,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,time",
      ],
    ],
  },
  plainnocuts: {
    fine: [
      [360, 640, "A/B,comment,hear options,play,time"],
      [644, 1400, "A/B,comment,hear options,play,skip back,skip forward,time"],
    ],
    coarse: [
      [360, 640, "A/B,comment,hear options,play,time"],
      [644, 1400, "A/B,comment,hear options,play,skip back,skip forward,time"],
    ],
  },
  plainguest: {
    fine: [
      [360, 640, "comment,play,time"],
      [644, 1400, "comment,play,skip back,skip forward,time"],
    ],
    coarse: [
      [360, 640, "comment,play,time"],
      [644, 1400, "comment,play,skip back,skip forward,time"],
    ],
  },
  plainguestcuts: {
    fine: [
      [360, 640, "comment,cuts,play,time"],
      [644, 1400, "comment,cuts,play,skip back,skip forward,time"],
    ],
    coarse: [
      [360, 640, "comment,cuts,play,time"],
      [652, 1400, "comment,cuts,play,skip back,skip forward,time"],
    ],
  },
  solo: {
    fine: [
      [432, 640, "A/B,comment,cuts,hear options,play,solo,time"],
      [
        644,
        800,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,solo,time",
      ],
      [
        804,
        1400,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,solo,time|t:solo",
      ],
    ],
    coarse: [
      [432, 640, "A/B,comment,cuts,hear options,play,solo,time"],
      [
        652,
        800,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,solo,time",
      ],
      [
        804,
        1400,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,solo,time|t:solo",
      ],
    ],
  },
  mixonly: {
    fine: [
      [432, 640, "A/B,comment,cuts,hear options,play,time,updating mix"],
      [
        644,
        800,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,time,updating mix",
      ],
      [
        804,
        1400,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,time,updating mix|t:updating mix",
      ],
    ],
    coarse: [
      [432, 640, "A/B,comment,cuts,hear options,play,time,updating mix"],
      [
        652,
        800,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,time,updating mix",
      ],
      [
        804,
        1400,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,time,updating mix|t:updating mix",
      ],
    ],
  },
  erroronly: {
    fine: [
      [432, 640, "A/B,audio error,cuts,hear options,play,retry,time"],
      [
        644,
        800,
        "A/B,audio error,cuts,hear options,play,retry,skip back,skip forward,time",
      ],
      [
        804,
        1400,
        "A/B,audio error,comment,cuts,hear options,play,retry,skip back,skip forward,time|t:audio error",
      ],
    ],
    coarse: [
      [432, 640, "A/B,audio error,cuts,hear options,play,retry,time"],
      [
        652,
        800,
        "A/B,audio error,cuts,hear options,play,retry,skip back,skip forward,time",
      ],
      [
        868,
        1400,
        "A/B,audio error,comment,cuts,hear options,play,retry,skip back,skip forward,time|t:audio error",
      ],
    ],
  },
  errornocuts: {
    fine: [
      [360, 640, "A/B,audio error,hear options,play,retry,time"],
      [
        644,
        800,
        "A/B,audio error,hear options,play,retry,skip back,skip forward,time",
      ],
      [
        804,
        1400,
        "A/B,audio error,comment,hear options,play,retry,skip back,skip forward,time|t:audio error",
      ],
    ],
    coarse: [
      [360, 640, "A/B,audio error,hear options,play,retry,time"],
      [
        644,
        800,
        "A/B,audio error,hear options,play,retry,skip back,skip forward,time",
      ],
      [
        868,
        1400,
        "A/B,audio error,comment,hear options,play,retry,skip back,skip forward,time|t:audio error",
      ],
    ],
  },
  staleonly: {
    fine: [
      [432, 640, "A/B,comment,cuts,hear options,play,status,time"],
      [
        644,
        800,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,status,time",
      ],
      [
        804,
        1400,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,status,time|t:status",
      ],
    ],
    coarse: [
      [432, 640, "A/B,comment,cuts,hear options,play,status,time"],
      [
        652,
        800,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,status,time",
      ],
      [
        804,
        1400,
        "A/B,comment,cuts,hear options,play,skip back,skip forward,status,time|t:status",
      ],
    ],
  },
  guesterror: {
    fine: [
      [360, 640, "audio error,play,retry,time"],
      [644, 800, "audio error,play,retry,skip back,skip forward,time"],
      [
        804,
        1400,
        "audio error,comment,play,retry,skip back,skip forward,time|t:audio error",
      ],
    ],
    coarse: [
      [360, 640, "audio error,play,retry,time"],
      [644, 800, "audio error,play,retry,skip back,skip forward,time"],
      [
        804,
        1400,
        "audio error,comment,play,retry,skip back,skip forward,time|t:audio error",
      ],
    ],
  },
  guestmix: {
    fine: [
      [360, 640, "comment,play,time,updating mix"],
      [644, 800, "comment,play,skip back,skip forward,time,updating mix"],
      [
        804,
        1400,
        "comment,play,skip back,skip forward,time,updating mix|t:updating mix",
      ],
    ],
    coarse: [
      [360, 640, "comment,play,time,updating mix"],
      [644, 800, "comment,play,skip back,skip forward,time,updating mix"],
      [
        804,
        1400,
        "comment,play,skip back,skip forward,time,updating mix|t:updating mix",
      ],
    ],
  },
  followcuts: {
    fine: [
      [448, 640, "A/B,comment,cuts,following,hear options,play,time"],
      [
        644,
        800,
        "A/B,comment,cuts,following,hear options,play,skip back,skip forward,time",
      ],
      [
        984,
        1400,
        "A/B,comment,cuts,following,hear options,play,skip back,skip forward,time|t:following|d:following",
      ],
    ],
    coarse: [
      [448, 640, "A/B,comment,cuts,following,hear options,play,time"],
      [
        676,
        800,
        "A/B,comment,cuts,following,hear options,play,skip back,skip forward,time",
      ],
      [
        1060,
        1400,
        "A/B,comment,cuts,following,hear options,play,skip back,skip forward,time|t:following|d:following",
      ],
    ],
  },
  followalone: {
    fine: [
      [372, 376, "A/B,comment,following,hear options,play,time"],
      [388, 640, "A/B,comment,following,hear options,play,time"],
      [
        644,
        800,
        "A/B,comment,following,hear options,play,skip back,skip forward,time",
      ],
      [
        984,
        1400,
        "A/B,comment,following,hear options,play,skip back,skip forward,time|t:following|d:following",
      ],
    ],
    coarse: [
      [372, 376, "A/B,comment,following,hear options,play,time"],
      [388, 640, "A/B,comment,following,hear options,play,time"],
      [
        676,
        800,
        "A/B,comment,following,hear options,play,skip back,skip forward,time",
      ],
      [
        1060,
        1400,
        "A/B,comment,following,hear options,play,skip back,skip forward,time|t:following|d:following",
      ],
    ],
  },
  guestfollow: {
    fine: [
      [360, 640, "comment,following,play,time"],
      [644, 800, "comment,following,play,skip back,skip forward,time"],
      [
        804,
        1400,
        "comment,following,play,skip back,skip forward,time|t:following|d:following",
      ],
    ],
    coarse: [
      [360, 640, "comment,following,play,time"],
      [644, 800, "comment,following,play,skip back,skip forward,time"],
      [
        804,
        1400,
        "comment,following,play,skip back,skip forward,time|t:following|d:following",
      ],
    ],
  },
};
