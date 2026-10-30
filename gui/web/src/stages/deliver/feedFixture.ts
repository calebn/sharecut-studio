import { formatClock } from "./deliverLogic";
import { isDrifted, isKnown, KEY, numberFact, textFact } from "./feedLogic";
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
  Served,
  ShowState,
} from "./feedView";

const COVER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" fill="#14343b"/><circle cx="170" cy="72" r="30" fill="#f2b45a"/><path d="M0 150 C40 120 80 180 120 150 S200 120 240 150 V240 H0Z" fill="#2a6f78"/><path d="M0 188 C40 158 80 218 120 188 S200 158 240 188 V240 H0Z" fill="#3f9aa3"/></svg>`;

export const SHOW_TITLE = "The Long River";
const EPISODE_TITLE = "Nobody asked the river";
const INTRO =
  "Ana walks the old mill road with hydrologist Mira Calder to ask who decided where the river should go.";

const ART: Art = {
  src: `data:image/svg+xml;utf8,${encodeURIComponent(COVER)}`,
  alt: "The Long River cover art: a low sun over layered blue water",
};

const ANA: Credit = { name: "Ana Reyes", role: "host" };
const MIRA: Credit = { name: "Dr. Mira Calder", role: "guest" };

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

const askFor = (key: FieldKey): Fix => ({ kind: "input", key });

const FIX_EXPORT: Fix = { kind: "command", command: "export_episode" };
const FIX_SHOW: Fix = { kind: "command", command: "create_show" };
const FIX_ART: Fix = { kind: "command", command: "choose_art" };

const NO_INTRO = missing("Say what this episode is about.", askFor(KEY.intro));
const NO_HOSTING = missing("Where will this be hosted?", askFor(KEY.hosting));
const NO_FILE = missing("Size and length come from the export.", FIX_EXPORT);

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
  (f.fix?.kind === "command" &&
    (f.fix.command === "create_show" || f.fix.command === "link_show"));

/** Stands in for the service's rules, for the values a person can fill in on this page. */
function editFindings(item: Scalars, show: ShowState): Finding[] {
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

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function known<T>(fact: Fact<T>): T | null {
  return isKnown(fact) ? fact.value : null;
}

/** Stands in for the service's notes renderer: the pinned text, or the intro with live chapters and credits. */
function renderNotes(view: FeedView): string {
  const notes = textFact(view.item, KEY.notes);
  if (isKnown(notes))
    return notes.value
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
  const intro = textFact(view.item, KEY.intro);
  const chapters = known(view.sections.chapters) ?? [];
  const credits = known(view.sections.credits) ?? [];
  return [
    isKnown(intro) ? `<p>${escapeHtml(intro.value)}</p>` : "",
    chapters.length > 0
      ? `<p>Chapters</p><ol>${chapters
          .map(
            (c) => `<li>${formatClock(c.at, true)} ${escapeHtml(c.title)}</li>`,
          )
          .join("")}</ol>`
      : "",
    credits.length > 0
      ? `<p>With</p><ul>${credits
          .map((c) => `<li>${escapeHtml(c.name)}, ${c.role}</li>`)
          .join("")}</ul>`
      : "",
  ].join("");
}

/** Stands in for the service's item renderer, so the XML pane and Copy notes follow an edit. */
function renderItemXml(view: FeedView): string {
  const { item, sections } = view;
  const title = textFact(item, KEY.title);
  const published = textFact(item, KEY.published);
  const guid = textFact(item, KEY.guid);
  const hosting = textFact(item, KEY.hosting);
  const duration = known(numberFact(item, KEY.duration));
  const audio = known(sections.audio);
  const line = (text: string | null) => (text === null ? [] : [`  ${text}`]);
  return [
    "<item>",
    ...line(
      isKnown(title) ? `<title>${escapeHtml(title.value)}</title>` : null,
    ),
    `  <description><![CDATA[${view.notesHtml}]]></description>`,
    ...line(
      isKnown(published)
        ? `<pubDate>${new Date(published.value).toUTCString()}</pubDate>`
        : null,
    ),
    ...line(
      isKnown(guid)
        ? `<guid isPermaLink="false">${escapeHtml(guid.value)}</guid>`
        : null,
    ),
    ...line(
      isKnown(hosting) && audio
        ? `<enclosure url="${escapeHtml(hosting.value)}" length="${audio.bytes}" type="${audio.mime}"/>`
        : null,
    ),
    ...line(
      duration === null
        ? null
        : `<itunes:duration>${duration}</itunes:duration>`,
    ),
    ...line(
      isKnown(sections.art)
        ? '<itunes:image href="https://cdn.example.test/long-river/cover.jpg"/>'
        : null,
    ),
    ...line(
      isKnown(sections.chapters)
        ? '<podcast:chapters url="https://cdn.example.test/long-river/ep-12.chapters.json" type="application/json+chapters"/>'
        : null,
    ),
    ...(known(sections.transcripts) ?? []).flatMap((t) =>
      line(
        `<podcast:transcript url="https://cdn.example.test/long-river/ep-12.${t.format.toLowerCase()}" type="${t.format === "SRT" ? "application/x-subrip" : "text/vtt"}" language="${t.language}"/>`,
      ),
    ),
    ...(known(sections.credits) ?? []).flatMap((c) =>
      line(
        `<podcast:person role="${c.role}">${escapeHtml(c.name)}</podcast:person>`,
      ),
    ),
    ...(known(sections.soundbites) ?? []).flatMap((b) =>
      line(
        `<podcast:soundbite startTime="${b.start}" duration="${b.end - b.start}">${escapeHtml(b.title)}</podcast:soundbite>`,
      ),
    ),
    "</item>",
  ].join("\n");
}

/** What a surface holds from the service: the view and the item as the feed file will carry it. */
export type { Served };

function serve(view: FeedView): Served {
  const rendered = { ...view, notesHtml: renderNotes(view) };
  return { view: rendered, itemXml: renderItemXml(rendered) };
}

type Parts = {
  item?: Scalars;
  sections?: Partial<Sections>;
  show?: ShowState;
  file?: FeedView["file"];
  extra?: readonly Finding[];
  driftDetail?: FeedView["driftDetail"];
};

function feedView({
  item = {},
  sections = {},
  show = { kind: "ready", id: "long-river" },
  file = "current",
  extra = [],
  driftDetail,
}: Parts = {}): FeedView {
  const scalars = { ...READY_ITEM, ...item };
  return serve({
    show,
    channel:
      show.kind === "ready" ? { [KEY.showTitle]: pinned(SHOW_TITLE) } : {},
    item: scalars,
    sections: { ...READY_SECTIONS, ...sections },
    notesHtml: "",
    driftDetail,
    findings: [...editFindings(scalars, show), ...extra, ...INFO],
    file,
  }).view;
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

export const UNREADABLE: FeedView = feedView({
  file: "none",
  show: {
    kind: "choose",
    shows: [{ id: "field-notes", title: "Field Notes" }],
  },
  item: FIRST_RUN_ITEM,
  sections: FIRST_RUN_SECTIONS,
  extra: [
    {
      key: "show",
      severity: "blocker",
      platform: null,
      message: "The show file the-long-river.yaml cannot be used.",
      fix: { kind: "command", command: "link_show" },
    },
  ],
});

export const GUEST_PIN: FeedView = feedView({
  item: {
    [KEY.intro]: pinned(
      "Ana asked the question nobody put to the river: who decided where it should run?",
      "guest",
    ),
  },
});

export const STALE: FeedView = feedView({ file: "stale" });

export { serve };

const AUTO: Record<FieldKey, Fact<FieldValue> | null> = {
  [KEY.title]: derived(EPISODE_TITLE, "the project name"),
  [KEY.intro]: NO_INTRO,
  [KEY.hosting]: NO_HOSTING,
  [KEY.notes]: null,
};

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const inChannel = (key: FieldKey) => key.startsWith("channel.");

/**
 * What the service does with an edit, for stories, tests and the shared golden:
 * pin it or hand it back. An empty set is an unset, and unsetting what holds
 * no pin changes nothing.
 */
function applyEdit(served: Served, edit: FeedEdit): Served {
  const { view } = served;
  const bucket = inChannel(edit.key) ? "channel" : "item";
  const facts = { ...view[bucket] };
  let driftDetail = view.driftDetail;
  if (edit.op === "set" && edit.value !== "") {
    facts[edit.key] = pinned(edit.value);
    driftDetail = undefined;
  } else {
    if (facts[edit.key]?.source.kind !== "pinned") return served;
    const auto = AUTO[edit.key];
    if (auto) facts[edit.key] = auto;
    else delete facts[edit.key];
    driftDetail = undefined;
  }
  const next = { ...view, [bucket]: facts, driftDetail };
  return serve({
    ...next,
    findings: [
      ...editFindings(next.item, next.show),
      ...view.findings.filter((f) => !isEditFinding(f)),
    ],
    file: view.file === "current" ? "stale" : view.file,
  });
}

/** The commands the harness answers: creating or linking a show, and writing the file. */
function applyCommand(
  served: Served,
  fix: Extract<Fix, { kind: "command" }>,
): Served {
  const { view } = served;
  const args = fix.args ?? {};
  let next = view;
  const ready = (id: string, title: string): FeedView => ({
    ...view,
    show: { kind: "ready", id },
    channel: { ...view.channel, [KEY.showTitle]: pinned(title) },
  });
  if (fix.command === "create_show" && args.title)
    next = ready(slug(args.title), args.title);
  else if (fix.command === "link_show" && view.show.kind === "choose") {
    const chosen = view.show.shows.find((s) => s.id === args.id);
    if (chosen) next = ready(chosen.id, chosen.title);
  } else if (
    fix.command === "write_feed" &&
    !view.findings.some((f) => f.severity === "blocker")
  )
    next = { ...view, file: "current" };
  return serve({
    ...next,
    findings: [
      ...editFindings(next.item, next.show),
      ...next.findings.filter((f) => !isEditFinding(f)),
    ],
  });
}

/** One action as the service takes it. An input fix carries no value, so it changes nothing until a set arrives. */
export function applyFix(served: Served, fix: Fix): Served {
  if (fix.kind === "input") return served;
  return fix.kind === "edit"
    ? applyEdit(served, fix.edit)
    : applyCommand(served, fix);
}
