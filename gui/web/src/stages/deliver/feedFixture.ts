import type {
  Art,
  Credit,
  Fact,
  FeedEdit,
  FeedView,
  Finding,
  ItemFacts,
  Known,
  Missing,
  Pinned,
  ShowState,
} from "./feedView";

const COVER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" fill="#14343b"/><circle cx="170" cy="72" r="30" fill="#f2b45a"/><path d="M0 150 C40 120 80 180 120 150 S200 120 240 150 V240 H0Z" fill="#2a6f78"/><path d="M0 188 C40 158 80 218 120 188 S200 158 240 188 V240 H0Z" fill="#3f9aa3"/></svg>`;

export const SHOW_TITLE = "The Long River";
export const EPISODE_TITLE = "Nobody asked the river";
export const INTRO =
  "Ana walks the old mill road with hydrologist Mira Calder to ask who decided where the river should go.";

export const ART: Art = {
  src: `data:image/svg+xml;utf8,${encodeURIComponent(COVER)}`,
  alt: "The Long River cover art: a low sun over layered blue water",
};

export const ANA: Credit = { name: "Ana Reyes", role: "host", colorIndex: 0 };
export const MIRA: Credit = {
  name: "Dr. Mira Calder",
  role: "guest",
  colorIndex: 3,
};

function derived<T>(value: T, rule: string): Known<T> {
  return { value, source: { kind: "derived", rule } };
}

function pinned<T>(
  value: T,
  by: Pinned["by"] = "person",
  drifted: Pinned["drifted"] = null,
): Known<T> {
  return { value, source: { kind: "pinned", by, drifted } };
}

const missing = (why: string, fix: Missing["source"]["fix"]): Missing => ({
  value: null,
  source: { kind: "pending", why, fix },
});

export const FIX_INTRO = {
  label: "Add a line about this episode",
  action: { kind: "edit", key: "item.intro" },
} as const;
export const FIX_HOSTING = {
  label: "Add address",
  action: { kind: "edit", key: "item.enclosure.url" },
} as const;
export const FIX_EXPORT = {
  label: "Export episode",
  action: { kind: "export" },
} as const;
export const FIX_SHOW = {
  label: "Set up your show",
  action: { kind: "show" },
} as const;

export const NO_INTRO = missing("Say what this episode is about.", FIX_INTRO);
export const NO_HOSTING = missing("Where will this be hosted?", FIX_HOSTING);
export const NO_FILE = missing(
  "Size and length come from the export.",
  FIX_EXPORT,
);

const READY_ITEM: ItemFacts = {
  title: derived(EPISODE_TITLE, "the project name"),
  intro: pinned(INTRO),
  notes: null,
  publishedAt: derived("2026-10-23T09:00:00Z", "the first export"),
  duration: {
    value: 3120,
    source: { kind: "measured", file: "episode.wav" },
  },
  art: { value: ART, source: { kind: "inherited", from: "show" } },
  hosting: pinned("https://cdn.example.test/long-river/ep-12.mp3"),
  file: {
    value: { mime: "audio/mpeg", bytes: 49_920_000 },
    source: { kind: "measured", file: "ep-12.mp3" },
  },
  chapters: derived(
    [
      { at: 0, title: "Cold open" },
      { at: 312.4, title: "The old mill" },
      { at: 1180, title: "What the river wanted" },
    ],
    "3 chapters",
  ),
  credits: derived([ANA, MIRA], "2 speakers"),
  transcripts: derived(["SRT", "VTT"], "the exported transcripts"),
  soundbites: derived(
    [
      { title: "Nobody asked the river", start: 612, end: 653 },
      { title: "The boat was still there", start: 1840, end: 1868 },
    ],
    "2 approved clips",
  ),
};

const INFO: readonly Finding[] = [
  {
    id: "info-funding",
    severity: "info",
    platform: "Podcasting 2.0",
    message: "No funding link. Add one if listeners can support the show.",
    fix: null,
  },
  {
    id: "info-season",
    severity: "info",
    platform: "Apple",
    message: "No season or episode number. Apple groups numbered episodes.",
    fix: null,
  },
];

const EDIT_FINDINGS = ["needs-show", "needs-hosting", "needs-intro"];

/** Stands in for the server's rules, for the two facts a person can fill in on this page. */
export function editFindings(item: ItemFacts, show: ShowState): Finding[] {
  const found: Finding[] = [];
  if (show.kind === "none")
    found.push({
      id: "needs-show",
      severity: "blocker",
      platform: "RSS",
      message: "The feed needs a show to belong to.",
      fix: FIX_SHOW,
    });
  if (item.hosting.source.kind === "pending")
    found.push({
      id: "needs-hosting",
      severity: "blocker",
      platform: "RSS",
      message: "The feed needs an address for the audio file.",
      fix: FIX_HOSTING,
    });
  if (item.intro.source.kind === "pending")
    found.push({
      id: "needs-intro",
      severity: "warn",
      platform: "Apple",
      message: "Apple shows the intro as the episode description.",
      fix: FIX_INTRO,
    });
  return found;
}

type Parts = {
  item?: Partial<ItemFacts>;
  show?: ShowState;
  file?: FeedView["file"];
  extra?: readonly Finding[];
};

export function feedView({
  item = {},
  show = { kind: "ready", title: SHOW_TITLE },
  file = "current",
  extra = [],
}: Parts = {}): FeedView {
  const facts = { ...READY_ITEM, ...item };
  return {
    show,
    item: facts,
    findings: [...editFindings(facts, show), ...extra, ...INFO],
    file,
  };
}

export const READY: FeedView = feedView();

export const AGENT_PIN: FeedView = feedView({
  item: {
    intro: pinned(
      "A walk along the old mill road, and the question nobody put to the river: who decided where it should run?",
      "agent",
    ),
  },
});

export const DRIFTED: FeedView = feedView({
  file: "stale",
  item: {
    notes: pinned(
      "Ana walks the old mill road with hydrologist Mira Calder to ask who decided where the river should go.\n\n0:00 Cold open\n5:12 The old mill\n19:40 Listener mail",
      "person",
      "chapters",
    ),
  },
});

export const PENDING: FeedView = feedView({
  file: "none",
  item: {
    intro: NO_INTRO,
    hosting: NO_HOSTING,
    file: NO_FILE,
    publishedAt: missing("Set when you export.", FIX_EXPORT),
    duration: missing("", null),
  },
});

export const CHECKS: FeedView = feedView({
  file: "none",
  item: { hosting: NO_HOSTING },
  extra: [
    {
      id: "warn-art",
      severity: "warn",
      platform: "Apple",
      message: "The cover art is under 1400 by 1400 pixels. Apple rejects it.",
      fix: { label: "Replace artwork", action: { kind: "art" } },
    },
    {
      id: "warn-length",
      severity: "info",
      platform: "Spotify",
      message: "Spotify shows only the first 100 characters of a title.",
      fix: null,
    },
  ],
});

export const FIRST_RUN: FeedView = feedView({
  file: "none",
  show: { kind: "none", suggest: { language: "English", hosts: [ANA] } },
  item: {
    intro: NO_INTRO,
    hosting: NO_HOSTING,
    file: NO_FILE,
    art: missing("Artwork comes from your show.", {
      label: "Add artwork",
      action: { kind: "art" },
    }),
    publishedAt: missing("Set when you export.", FIX_EXPORT),
    duration: missing("", null),
  },
});

export const STALE: FeedView = feedView({ file: "stale" });

export const ITEM_XML = `<item>
  <title>Nobody asked the river</title>
  <description><![CDATA[<p>Ana walks the old mill road with hydrologist Mira Calder to ask who decided where the river should go.</p><p>Chapters</p><ol><li>0:00 Cold open</li><li>5:12 The old mill</li><li>19:40 What the river wanted</li></ol>]]></description>
  <pubDate>Fri, 23 Oct 2026 09:00:00 GMT</pubDate>
  <guid isPermaLink="false">urn:uuid:7c0e5a1e-4f3b-4a52-9d0e-6a1b2c3d4e5f</guid>
  <enclosure url="https://cdn.example.test/long-river/ep-12.mp3" length="49920000" type="audio/mpeg"/>
  <itunes:duration>3120</itunes:duration>
  <itunes:image href="https://cdn.example.test/long-river/cover.jpg"/>
  <podcast:chapters url="https://cdn.example.test/long-river/ep-12.chapters.json" type="application/json+chapters"/>
  <podcast:transcript url="https://cdn.example.test/long-river/ep-12.srt" type="application/x-subrip" language="en"/>
  <podcast:transcript url="https://cdn.example.test/long-river/ep-12.vtt" type="text/vtt" language="en"/>
  <podcast:person role="host">Ana Reyes</podcast:person>
  <podcast:person role="guest">Dr. Mira Calder</podcast:person>
  <podcast:soundbite startTime="612" duration="41">Nobody asked the river</podcast:soundbite>
  <podcast:soundbite startTime="1840" duration="28">The boat was still there</podcast:soundbite>
</item>`;

const AUTO_TITLE: Fact<string> = derived(EPISODE_TITLE, "the project name");

/** What the server does with an edit, for stories and tests: pin it or hand it back. */
export function applyEdit(view: FeedView, edit: FeedEdit): FeedView {
  const item = { ...view.item };
  if (edit.op === "set") {
    const value = pinned(edit.value);
    if (edit.key === "item.title") item.title = value;
    else if (edit.key === "item.intro") item.intro = value;
    else if (edit.key === "item.notes") item.notes = value;
    else item.hosting = value;
  } else if (edit.key === "item.title") item.title = AUTO_TITLE;
  else if (edit.key === "item.intro") item.intro = NO_INTRO;
  else if (edit.key === "item.notes") item.notes = null;
  else item.hosting = NO_HOSTING;
  const kept = view.findings.filter((f) => !EDIT_FINDINGS.includes(f.id));
  return {
    ...view,
    item,
    findings: [...editFindings(item, view.show), ...kept],
    file: view.file === "current" ? "stale" : view.file,
  };
}
