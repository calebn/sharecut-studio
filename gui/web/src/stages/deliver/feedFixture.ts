import { isDrifted, KEY } from "./feedLogic";
import type {
  Art,
  Credit,
  Fact,
  FeedEdit,
  FeedView,
  FieldKey,
  FieldValue,
  Finding,
  Fix,
  Known,
  Missing,
  Pinned,
  Sections,
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

export const ANA: Credit = { name: "Ana Reyes", role: "host" };
export const MIRA: Credit = { name: "Dr. Mira Calder", role: "guest" };

type Scalars = Record<FieldKey, Fact<FieldValue>>;

function derived<T>(value: T, rule: string): Known<T> {
  return { value, source: { kind: "derived", rule } };
}

function pinned<T>(
  value: T,
  by: Pinned["by"] = "person",
  drifted = false,
): Known<T> {
  return { value, source: { kind: "pinned", by, drifted } };
}

const missing = (
  why: string,
  fix: Missing["source"]["fix"] = null,
): Missing => ({
  value: null,
  source: { kind: "pending", why, fix },
});

const askFor = (key: FieldKey): Fix => ({
  kind: "edit",
  edit: { op: "set", key, value: "" },
});

export const FIX_INTRO = askFor(KEY.intro);
export const FIX_HOSTING = askFor(KEY.hosting);
export const FIX_EXPORT: Fix = { kind: "command", command: "export_episode" };
export const FIX_SHOW: Fix = { kind: "command", command: "create_show" };
export const FIX_ART: Fix = { kind: "command", command: "choose_art" };

export const NO_INTRO = missing("Say what this episode is about.", FIX_INTRO);
export const NO_HOSTING = missing("Where will this be hosted?", FIX_HOSTING);
export const NO_FILE = missing(
  "Size and length come from the export.",
  FIX_EXPORT,
);

const READY_ITEM: Scalars = {
  [KEY.title]: derived(EPISODE_TITLE, "the project name"),
  [KEY.intro]: pinned(INTRO),
  [KEY.published]: derived("2026-10-23T09:00:00Z", "the first export"),
  [KEY.duration]: {
    value: 3120,
    source: { kind: "measured", file: "episode.wav" },
  },
  [KEY.guid]: {
    value: "urn:uuid:7c0e5a1e-4f3b-4a52-9d0e-6a1b2c3d4e5f",
    source: { kind: "minted", at: "2026-10-23T09:00:00Z" },
  },
  [KEY.hosting]: pinned("https://cdn.example.test/long-river/ep-12.mp3"),
};

const READY_SECTIONS: Sections = {
  art: {
    value: ART,
    source: { kind: "inherited", from: "channel.image" },
  },
  audio: {
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
  transcripts: derived(
    [
      { format: "SRT", language: "en" },
      { format: "VTT", language: "en" },
    ],
    "the exported transcripts",
  ),
  soundbites: derived(
    [
      { title: "Nobody asked the river", start: 612, end: 653 },
      { title: "The boat was still there", start: 1840, end: 1868 },
    ],
    "2 approved clips",
  ),
};

export const NOTES_HTML = `<p>${INTRO}</p><p>Chapters</p><ol><li>0:00 Cold open</li><li>5:12 The old mill</li><li>19:40 What the river wanted</li></ol><p>With</p><ul><li>Ana Reyes, host</li><li>Dr. Mira Calder, guest</li></ul>`;

const INFO: readonly Finding[] = [
  {
    key: null,
    severity: "info",
    platform: "Podcasting 2.0",
    message: "No funding link. Add one if listeners can support the show.",
    fix: null,
  },
  {
    key: null,
    severity: "info",
    platform: "Apple",
    message: "No season or episode number. Apple groups numbered episodes.",
    fix: null,
  },
];

const isEditFinding = (f: Finding) =>
  f.key === KEY.hosting ||
  f.key === KEY.intro ||
  f.key === KEY.notes ||
  (f.fix?.kind === "command" && f.fix.command === "create_show");

/** Stands in for the service's rules, for the values a person can fill in on this page. */
export function editFindings(item: Scalars, show: ShowState): Finding[] {
  const found: Finding[] = [];
  if (show.kind !== "ready")
    found.push({
      key: null,
      severity: "blocker",
      platform: "RSS",
      message: "The feed needs a show to belong to.",
      fix:
        show.kind === "none"
          ? FIX_SHOW
          : { kind: "command", command: "link_show" },
    });
  const hosting = item[KEY.hosting];
  if (hosting?.source.kind === "pending")
    found.push({
      key: KEY.hosting,
      severity: "blocker",
      platform: "RSS",
      message: "The feed needs an address for the audio file.",
      fix: hosting.source.fix,
    });
  const intro = item[KEY.intro];
  if (intro?.source.kind === "pending")
    found.push({
      key: KEY.intro,
      severity: "warn",
      platform: "Apple",
      message: "Apple shows the intro as the episode description.",
      fix: intro.source.fix,
    });
  if (isDrifted(item[KEY.notes]))
    found.push({
      key: KEY.notes,
      severity: "info",
      platform: null,
      message: "The notes changed since you edited them.",
      fix: null,
    });
  return found;
}

type Parts = {
  item?: Scalars;
  sections?: Partial<Sections>;
  show?: ShowState;
  file?: FeedView["file"];
  extra?: readonly Finding[];
  driftDetail?: FeedView["driftDetail"];
};

export function feedView({
  item = {},
  sections = {},
  show = { kind: "ready", title: SHOW_TITLE },
  file = "current",
  extra = [],
  driftDetail,
}: Parts = {}): FeedView {
  const scalars = { ...READY_ITEM, ...item };
  return {
    show,
    channel: {
      [KEY.showTitle]: pinned(SHOW_TITLE),
    },
    item: scalars,
    sections: { ...READY_SECTIONS, ...sections },
    notesHtml: NOTES_HTML,
    driftDetail,
    findings: [...editFindings(scalars, show), ...extra, ...INFO],
    file,
  };
}

export const READY: FeedView = feedView();

export const AGENT_PIN: FeedView = feedView({
  item: {
    [KEY.intro]: pinned(
      "A walk along the old mill road, and the question nobody put to the river: who decided where it should run?",
      "agent",
    ),
  },
});

export const DRIFTED: FeedView = feedView({
  file: "stale",
  item: {
    [KEY.notes]: pinned(
      `${INTRO}\n\n0:00 Cold open\n5:12 The old mill\n19:40 Listener mail`,
      "person",
      true,
    ),
  },
  driftDetail: {
    [KEY.notes]:
      "A chapter was renamed: \u201cListener mail\u201d is now \u201cWhat the river wanted\u201d.",
  },
});

export const PENDING: FeedView = feedView({
  file: "none",
  item: {
    [KEY.intro]: NO_INTRO,
    [KEY.hosting]: NO_HOSTING,
    [KEY.published]: missing("Set when you export.", FIX_EXPORT),
    [KEY.duration]: missing("Measured from the export."),
  },
  sections: { audio: NO_FILE },
});

export const CHECKS: FeedView = feedView({
  file: "none",
  item: { [KEY.hosting]: NO_HOSTING },
  extra: [
    {
      key: null,
      severity: "warn",
      platform: "Apple",
      message: "The cover art is under 1400 by 1400 pixels. Apple rejects it.",
      fix: FIX_ART,
    },
    {
      key: KEY.title,
      severity: "info",
      platform: "Spotify",
      message: "Spotify shows only the first 100 characters of a title.",
      fix: null,
    },
  ],
});

const FIRST_RUN_ITEM: Scalars = {
  [KEY.intro]: NO_INTRO,
  [KEY.hosting]: NO_HOSTING,
  [KEY.published]: missing("Set when you export.", FIX_EXPORT),
  [KEY.duration]: missing("Measured from the export."),
};
const FIRST_RUN_SECTIONS: Partial<Sections> = {
  audio: NO_FILE,
  art: missing("Artwork comes from your show.", FIX_ART),
};

export const FIRST_RUN: FeedView = feedView({
  file: "none",
  show: { kind: "none", suggest: { language: "English", hosts: [ANA] } },
  item: FIRST_RUN_ITEM,
  sections: FIRST_RUN_SECTIONS,
});

export const CHOOSE_SHOW: FeedView = feedView({
  file: "none",
  show: {
    kind: "choose",
    shows: [
      { id: "long-river", title: SHOW_TITLE },
      { id: "field-notes", title: "Field Notes" },
    ],
  },
  item: FIRST_RUN_ITEM,
  sections: FIRST_RUN_SECTIONS,
});

export const STALE: FeedView = feedView({ file: "stale" });
export const WRITING: FeedView = feedView({ file: "writing" });
export const WRITE_FAILED: FeedView = feedView({ file: "error" });

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

const AUTO: Record<FieldKey, Fact<FieldValue> | null> = {
  [KEY.title]: derived(EPISODE_TITLE, "the project name"),
  [KEY.intro]: NO_INTRO,
  [KEY.hosting]: NO_HOSTING,
  [KEY.notes]: null,
};

/** What the service does with an edit, for stories and tests: pin it or hand it back. */
export function applyEdit(view: FeedView, edit: FeedEdit): FeedView {
  const item = { ...view.item };
  let driftDetail = view.driftDetail;
  if (edit.op === "set") item[edit.key] = pinned(edit.value);
  else {
    const auto = AUTO[edit.key];
    if (auto === undefined)
      throw new Error(`applyEdit: no auto value for ${edit.key}`);
    if (auto === null) {
      delete item[edit.key];
      driftDetail = undefined;
    } else item[edit.key] = auto;
  }
  if (edit.op === "set") driftDetail = undefined;
  const kept = view.findings.filter((f) => !isEditFinding(f));
  return {
    ...view,
    item,
    driftDetail,
    findings: [...editFindings(item, view.show), ...kept],
    file: view.file === "current" ? "stale" : view.file,
  };
}

/** The commands the harness answers: creating or linking a show, and writing the file. */
export function applyFix(view: FeedView, fix: Fix): FeedView {
  if (fix.kind === "edit") return applyEdit(view, fix.edit);
  const args = fix.args ?? {};
  let next = view;
  if (fix.command === "create_show" && args.title)
    next = { ...view, show: { kind: "ready", title: args.title } };
  else if (fix.command === "link_show" && view.show.kind === "choose") {
    const chosen = view.show.shows.find((s) => s.id === args.id);
    if (chosen)
      next = { ...view, show: { kind: "ready", title: chosen.title } };
  } else if (fix.command === "write_feed") next = { ...view, file: "current" };
  const kept = next.findings.filter((f) => !isEditFinding(f));
  return {
    ...next,
    findings: [...editFindings(next.item, next.show), ...kept],
  };
}
