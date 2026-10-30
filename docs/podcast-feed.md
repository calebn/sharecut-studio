# Podcast listing

The podcast listing is how an episode looks in a podcast app and what its RSS feed says. Studio computes it on every read from the episode project, the files in `export/` and, later, the show. Nothing derived is stored. The only listing state in `episode.sharecut` is `feed`: a show link, a guid and first export time made once, and the pins a person or agent set.

This page covers the read side, the pins, the CLI, MCP and HTTP surfaces and the feed XML. The show store, the feed file writer and the Deliver section arrive in later slices (issue #2684).

## How a value is resolved

Each row of the field registry (`src/podcast_mcp/feed/fields.py`, `FIELDS`) resolves to one fact: a value and where it came from.

| Source | Meaning |
|---|---|
| `derived` | Computed from the project, such as the title from the project name. |
| `inherited` | Taken from the show, such as artwork or explicit, until the episode sets its own. |
| `measured` | Read from an exported file: its size, or the WAV header's length. |
| `minted` | Made once and kept, such as the guid. |
| `pinned` | Set by a person or an agent. `drifted` says the automatic value changed after the pin was made. |
| `pending` | Missing. It says why and carries the fix: an edit, a value only a person can give (`input`) or a command such as exporting. |

`resolve(inputs, pins)` is pure and returns the whole `FeedView`; `render(view)` turns it into XML. `FeedService` (`services/document/feed.py`) gathers the inputs and is the only thing an adapter calls.

The view's JSON is the contract the Deliver section reads (`gui/web/src/stages/deliver/feedView.ts`). `tests/fixtures/feed/feed_golden.json` holds the shared `(view, fix) -> view` cases. vitest passes them through the web fixture server and `tests/test_feed_golden.py` passes the same cases through `resolve` and `render`, so the two cannot drift.

## Pins and drift

A pin stores the value and a digest of the automatic value it replaced. A read compares that digest with the automatic value now. If they differ, the pin is `drifted` and the view adds an info finding and a `driftDetail` sentence. Nothing about drift is stored.

- Keep mine: set the same value again. The digest is taken afresh, so the drift clears.
- Use new: unset the key. The automatic value returns.
- Setting empty or blank text is an unset on every surface. Unsetting a known key that holds no pin changes nothing and writes nothing. Unsetting or setting a key that names nothing, or an `item.person[Name]` key for someone who is not a speaker, is refused with `feed_field_unknown`, so a typo is never silent.
- Show notes are composed live from the intro, the chapters, the credits and a transcript link. Setting `item.notes` pins the whole text. Unset returns to the composition.

Episode pins are saved through two document commands, `SetFeedField` and `ClearFeedField`, so each edit is one history step, journals for open Studio tabs and undoes with `history_undo` or `podcast undo` like a chapter edit. An Editor share link can submit them too, for `item.*` keys only; see [Guests](#guests).

## Fields

Chapters, transcripts, soundbites and people are edited where they live: the Chapters list, the Transcript section, the Clips row and the Edit stage. The listing links to them and never edits them. A speaker's attributes are the exception: pin `item.person[Name].role`, `.group`, `.img`, `.href` or `.exclude` to change how one person is listed. `Name` is the speaker's name as written, brackets included, and must be a speaker on the episode. A `role` must be a Podcast Taxonomy role such as `host`, `co-host` or `guest` (any case; the error lists the rest), and `group` is at most 128 characters. A speaker who is not on the show's host list is listed as a guest with a warning.

| Key | Scope | Edited | Feed tags | What it is |
|---|---|---|---|---|
| `channel.title` | show | Set on the show. Not available yet. | `title` | The show's name. |
| `channel.description` | show | Set on the show. Not available yet. | `description` | What the show is about, plain text. |
| `channel.link` | show | Set on the show. Not available yet. | `link` | The show's website address. |
| `channel.language` | show | Set on the show. Not available yet. | `language` | Language code such as en or pt-BR. |
| `channel.author` | show | Set on the show. Not available yet. | `itunes:author` | Who makes the show, as listeners see it. |
| `channel.category` | show | Set on the show. Not available yet. | `itunes:category@text` | An Apple Podcasts category such as Society & Culture. |
| `channel.explicit` | show | Set on the show. Not available yet. | `itunes:explicit` | Whether the show has explicit content. |
| `channel.image` | show | Set on the show. Not available yet. | `itunes:image@href` | Square show artwork, 1400 to 3000 pixels, at an https address. |
| `channel.owner.name` | show | Set on the show. Not available yet. | `itunes:owner/itunes:name` | Who owns the show. Public in the feed. |
| `channel.owner.email` | show | Set on the show. Not available yet. | `itunes:owner/itunes:email` | Where Spotify and YouTube send the ownership check. Public in the feed. |
| `channel.copyright` | show | Set on the show. Not available yet. | `copyright` | A copyright line without the word Copyright. |
| `channel.mediaUrl` | show | Set on the show. Not available yet. | none | Where files will live, with {file} where the file name goes. |
| `channel.feedUrl` | show | measured or made | `atom:link@href` | Where the feed file will live. Made from the hosting address. |
| `channel.podcastGuid` | show | measured or made | `podcast:guid` | The show's Podcasting 2.0 id. Made from the feed address. |
| `item.title` | episode | feed set | `title` | The episode title. Defaults to the project name. |
| `item.intro` | episode | feed set | none | A line or two about this episode. Leads the show notes. |
| `item.pubDate` | episode | feed set | `pubDate` | When the episode goes out, as an ISO 8601 time. Defaults to the first export. |
| `item.guid` | episode | made once | `guid` | The episode's permanent id. Made once and never edited. |
| `item.enclosure.url` | episode | feed set | `enclosure@url` | The full https address of the audio file. Defaults to the show's hosting address. |
| `item.enclosure.length` | episode | measured or made | `enclosure@length` | Bytes of the exported audio file. |
| `item.enclosure.type` | episode | measured or made | `enclosure@type` | The audio file's media type. |
| `item.duration` | episode | measured or made | `itunes:duration` | Seconds, read from the exported WAV. |
| `item.explicit` | episode | feed set | `itunes:explicit` | Whether this episode is explicit. Defaults to the show. |
| `item.season` | episode | feed set | `itunes:season` | The season number. |
| `item.episode` | episode | feed set | `itunes:episode` | The episode number. |
| `item.episodeType` | episode | feed set | `itunes:episodeType` | full, trailer or bonus. |
| `item.image` | episode | feed set | `itunes:image@href` | Episode artwork at an https address. Defaults to the show's. |
| `item.audio` | episode | measured or made | none | The exported audio file, by name and size. |
| `item.chapters` | episode | Edit chapters in the Chapters list. | `podcast:chapters` | Chapter markers, shown in the notes and linked as a chapters file. |
| `item.transcript` | episode | Choose transcript formats in the Transcript section. | `podcast:transcript` | Every SRT and VTT transcript the export wrote. |
| `item.soundbite` | episode | Approve clips in the Clips row. | `podcast:soundbite` | Approved clips, offered to apps as highlights. |
| `item.person` | episode | Name speakers in the Edit stage. | `podcast:person` | Speakers matched to the show's host list. Pin item.person[Name].role, group, img, href or exclude to change one. |
| `item.notes` | episode | feed set | `description`, `content:encoded` | Show notes. Left alone they are the intro, chapters, credits and transcript link. Setting them pins the whole text. |

`item.pubDate` takes any ISO 8601 date or time: an offset is converted to UTC, a time with no offset is UTC and a bare date is midnight UTC. The pin stores `YYYY-MM-DDTHH:MM:SSZ` and the feed shows it as an RFC 2822 date in GMT. `item.season` and `item.episode` are whole numbers from 1 to 999999.

Show rows read from a show profile. The show store lands in the next slice, so until then they are pending with a fix, `feed set` refuses them with `feed_show_unavailable`, and the feed has one blocker, "The feed needs a show to belong to." With exactly one show on the machine the episode belongs to it without linking.

## Findings

Every finding has a severity, the platform it protects, a message and, when one exists, the fix.

- **blocker**: the XML would break RSS 2.0 or the podcast minimum. A missing show, title, description or website, an audio file that was never exported, an export with only a WAV, or no address for the audio file. A blocker never stops the audio export.
- **warn**: a platform will complain. Missing intro, language, category, explicit flag or artwork (Apple), notes over 10,000 characters (Apple) or 4,000 bytes (PSP-1), a soundbite outside 15 to 120 seconds, a speaker listed as a guest (Podcasting 2.0).
- **info**: optional or advisory. A long title (Spotify), no owner email, no episode number, and a changed pin.

Findings sort blocker, warn, info.

Before the feed file is first written the episode has no guid. The XML leaves `<guid>` out, and the view says so with an info finding on `item.guid`, "Created when you write the feed file." It never blocks.

## Hosting

One show setting, `channel.mediaUrl`, is a template such as `https://cdn.example.com/show/{file}`. Studio uses it for the audio, the chapters file, the transcripts and the feed address. An episode can pin a full `item.enclosure.url` instead. The address must be https and ASCII. Until one of them exists the view says "Where will this be hosted?" and the XML leaves the element out. The XML never contains a placeholder address.

Studio looks for these files in `export/`, named after the project: `<name>.mp3` or `.m4a` for the enclosure, `<name>.wav` for the duration, `<name>.vtt` and `<name>.srt` for transcripts and `<name>.feed.xml` for the feed file. A WAV alone is a blocker. The chapters file is not looked for. When the episode has chapters and the hosting address and an exported audio file are known, the feed links to `<name>.chapters.json` at the hosting address, the name the export writes. A feed file that cannot be read as UTF-8 counts as `stale`.

## Feed XML

`podcast feed show --xml` prints a channel with this episode as its one item. `--item` prints the bare `<item>` for people who keep their own feed. Elements appear only when their fact is known. The notes go in `description` and `content:encoded` as CDATA, limited to `p`, `ol`, `ul`, `li` and `a`. Pinned notes become one `<p>` per non-blank line, because a line break (`<br>`) is outside the set podcast apps accept. The file state is `none` when `<name>.feed.xml` does not exist, `current` when it equals what `render` gives now and `stale` otherwise.

## Guests

A guest with an Editor share link edits the episode's listing; a Viewer or Commenter link cannot. `SetFeedField` and `ClearFeedField` are in the Editor command set (`document_sync/capabilities.py`, `EDIT_COMMANDS`), so the guest sends them to `POST /api/review/{token}/daw/document/command` like any other edit, and a Viewer or Commenter gets `share_capability_required`. The payload gate refuses a guest key that is not `item.*` (never a show setting), and a guest cannot claim an agent as author. Values are checked as for the host, so an https address is the only kind of address a guest can set, and the guest event carries only the command type, never the key, the value or a host path. A guest edit is one history step; an Editor undoes it with `UndoHistory`.

A share that can view reads the listing with `GET /api/review/{token}/feed`, which returns the same `{view, itemXml}` as `GET /api/feed` and is rate limited like the other guest reads. The guest MCP has no listing tools of its own: its tool list is a fixed allow-list by capability, not one tool per command, so an Editor's agent writes a value with `guest_submit_document_command` (type `SetFeedField`) and reads it over the HTTP route.

## Surfaces

| Surface | Read | Edit |
|---|---|---|
| CLI | `podcast feed show -p P [--json \| --xml \| --item \| --notes \| --shows] [--check [--strict]]`, `podcast feed fields [--json]` | `podcast feed set -p P KEY VALUE` (`@file` reads a file), `podcast feed unset -p P KEY` |
| MCP | `feed_read(project_path, view)` with `view` one of `facts`, `item_xml`, `feed_xml`, `notes_html`, `show` | `feed_set(project_path, field, value)`, `feed_unset(project_path, field)`. Agent pins are marked `agent`. |
| HTTP | `GET /api/feed?path=` returns `{view, itemXml}`; guests: `GET /api/review/{token}/feed` | `POST /api/feed/edit` with `{path, edit}` where `edit` is `{op: "set", key, value}` or `{op: "unset", key}` |

`--check` exits 1 when a blocker stands. `--xml` prints the file and then, while a blocker stands, warns on stderr and exits 1, so a script cannot save an invalid feed unnoticed; `--item` is never held back. A `@file` that cannot be read as UTF-8 text is `feed_file_unreadable`. An unknown MCP `view` is `feed_view_unknown`. `feed_set` takes text, a number or true/false for `value`; `2` and `"2"` are the same. `--strict` also fails on warnings and changed pins. The `/api/feed` routes require the host role. The capability rows are `daw.feed.read` and `daw.feed.edit`; the skill is `podcast-rss-feed`.

An agent writes the episode intro with `feed_set(project_path, "item.intro", text)`. See [the skill](../.agents/skills/podcast-rss-feed/SKILL.md).

## Where it lives

| Piece | Path |
|---|---|
| Registry, rules, resolver, XML | `src/podcast_mcp/feed/` (`fields.py`, `resolve.py`, `render.py`, `notes.py`) |
| Persisted shape | `src/podcast_mcp/models/feed.py`, `EpisodeProject.feed` ([episode format](episode-format-v2.md#feed)) |
| Service | `src/podcast_mcp/services/document/feed.py` |
| Document commands | `SetFeedField`, `ClearFeedField` ([session sync](session-sync.md#document-plane-api)) |
| Adapters | `cli/feed.py`, `mcp/tools/feed.py`, `gui/routes/feed_routes.py` |
