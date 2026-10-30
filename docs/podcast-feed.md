# Podcast listing

The podcast listing is how an episode looks in a podcast app and what its RSS feed says. Studio computes it on every read from the episode project, the files in `export/` and the episode's show. Nothing derived is stored. The only listing state in `episode.sharecut` is `feed`: a show link, a guid and first export time made once, and the pins a person or agent set. What every episode of a show shares lives in the show's own file.

This page covers the read side, the pins, the shows, writing the feed file, the CLI, MCP and HTTP surfaces and the feed XML (issue #2684).

## How a value is resolved

Each row of the field registry (`src/podcast_mcp/feed/fields.py`, `FIELDS`) resolves to one fact: a value and where it came from.

| Source | Meaning |
|---|---|
| `derived` | Computed from the project, such as the title from the project name. |
| `inherited` | Taken from the show, such as artwork or explicit, until the episode sets its own. |
| `measured` | Read from an exported file: its size, or the WAV header's length. |
| `minted` | Made once and kept, such as the guid. |
| `pinned` | Set by a person, an agent or a guest on an Editor link. `drifted` says the automatic value changed after the pin was made. |
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
| `show` | episode | `feed set` | none | The show this episode belongs to. A show's name creates it, a show's id chooses it. |
| `channel.title` | show | `feed set` (on the show) | `title` | The show's name. |
| `channel.description` | show | `feed set` (on the show) | `description` | What the show is about, plain text. |
| `channel.link` | show | `feed set` (on the show) | `link` | The show's website address. |
| `channel.language` | show | `feed set` (on the show) | `language` | Language code such as en or pt-BR. |
| `channel.author` | show | `feed set` (on the show) | `itunes:author` | Who makes the show, as listeners see it. |
| `channel.category` | show | `feed set` (on the show) | `itunes:category@text` | An Apple Podcasts category such as Society & Culture. |
| `channel.explicit` | show | `feed set` (on the show) | `itunes:explicit` | Whether the show has explicit content. |
| `channel.image` | show | `feed set` (on the show) | `itunes:image@href` | Square show artwork, 1400 to 3000 pixels: an https address, or a .jpg or .png file here that the export copies beside the audio. |
| `channel.owner.name` | show | `feed set` (on the show) | `itunes:owner/itunes:name` | Who owns the show. Public in the feed. |
| `channel.owner.email` | show | `feed set` (on the show) | `itunes:owner/itunes:email` | Where Spotify and YouTube send the ownership check. Public in the feed. |
| `channel.copyright` | show | `feed set` (on the show) | `copyright` | A copyright line without the word Copyright. |
| `channel.mediaUrl` | show | `feed set` (on the show) | none | Where files will live, with {file} where the file name goes. |
| `channel.feedUrl` | show | measured or made | `atom:link@href` | Where the feed file will live. Made from the hosting address. |
| `channel.podcastGuid` | show | measured or made | `podcast:guid` | The show's Podcasting 2.0 id. Made from the feed address. |
| `channel.season` | show | `feed set` (on the show) | none | The season every episode of the show is in until an episode sets its own. |
| `channel.roster` | show | Set a person with channel.person[Name].role, group, img or href. | none | The people who host the show, matched to speakers by name. |
| `item.title` | episode | `feed set` | `title` | The episode title. Defaults to the project name. |
| `item.intro` | episode | `feed set` | none | A line or two about this episode. Leads the show notes. |
| `item.pubDate` | episode | `feed set` | `pubDate` | When the episode goes out, as an ISO 8601 time. Defaults to the first export. |
| `item.guid` | episode | made once | `guid` | The episode's permanent id. Made once and never edited. |
| `item.enclosure.url` | episode | `feed set` | `enclosure@url` | The full https address of the audio file. Defaults to the show's hosting address. |
| `item.enclosure.length` | episode | measured or made | `enclosure@length` | Bytes of the exported audio file. |
| `item.enclosure.type` | episode | measured or made | `enclosure@type` | The audio file's media type. |
| `item.duration` | episode | measured or made | `itunes:duration` | Seconds, read from the exported WAV. |
| `item.explicit` | episode | `feed set` | `itunes:explicit` | Whether this episode is explicit. Defaults to the show. |
| `item.season` | episode | `feed set` | `itunes:season` | The season number. |
| `item.episode` | episode | `feed set` | `itunes:episode` | The episode number. |
| `item.episodeType` | episode | `feed set` | `itunes:episodeType` | full, trailer or bonus. |
| `item.image` | episode | `feed set` | `itunes:image@href` | Episode artwork at an https address. Defaults to the show's. |
| `item.audio` | episode | measured or made | none | The exported audio file, by name and size. |
| `item.chapters` | episode | Edit chapters in the Chapters list. | `podcast:chapters` | Chapter markers, shown in the notes and linked as a chapters file. |
| `item.transcript` | episode | Choose transcript formats in the Transcript section. | `podcast:transcript` | Every SRT and VTT transcript the export wrote. |
| `item.soundbite` | episode | Approve clips in the Clips row. | `podcast:soundbite` | Approved clips, offered to apps as highlights. |
| `item.person` | episode | Name speakers in the Edit stage. | `podcast:person` | Speakers matched to the show's host list. Pin item.person[Name].role, group, img, href or exclude to change one. |
| `item.notes` | episode | `feed set` | `description`, `content:encoded` | Show notes. Left alone they are the intro, chapters, credits and transcript link. Setting them pins the whole text. |
| `channel.locked` | show | `feed set` (on the show) | `podcast:locked` | Whether other hosts may import this feed. Written as yes or no. |
| `channel.type` | show | `feed set` (on the show) | `itunes:type` | episodic (newest first) or serial (oldest first). Written as episodic or serial. |
| `channel.block` | show | `feed set` (on the show) | `itunes:block` | Keeps the show out of Apple Podcasts. Written as yes. |
| `channel.complete` | show | `feed set` (on the show) | `itunes:complete` | Says the show will have no more episodes. Written as yes. |
| `channel.newFeedUrl` | show | `feed set` (on the show) | `itunes:new-feed-url` | Where the show's feed has moved to. Written as https://example.test/feed.xml. |
| `channel.medium` | show | `feed set` (on the show) | `podcast:medium` | What the show is: podcast, music, video, film, audiobook, newsletter or blog. Written as podcast. |
| `channel.updateFrequency` | show | `feed set` (on the show) | `podcast:updateFrequency` | How often new episodes come, in your words. Written as Weekly. |
| `channel.trailer` | show | `feed set` (on the show) | `podcast:trailer` | A short preview of the show. Written as https://example.test/trailer.mp3 2026-11-01T09:00:00Z Trailer title. |
| `channel.podroll` | show | `feed set` (on the show) | `podcast:podroll` | Shows you recommend, one feed per line. Written as feed-guid [https://example.test/feed.xml]. |
| `channel.publisher` | show | `feed set` (on the show) | `podcast:publisher` | The company that publishes this show. Written as feed-guid [https://example.test/feed.xml]. |
| `channel.funding` | show | `feed set` (on the show) | `podcast:funding` | Where listeners can give money. Written as https://example.test/give [message]. |
| `channel.license` | show | `feed set` (on the show) | `podcast:license` | The license the content is under. Written as cc-by-4.0 [https://example.test/license]. |
| `channel.location` | show | `feed set` (on the show) | `podcast:location` | The place the content is about. |
| `channel.txt` | show | `feed set` (on the show) | `podcast:txt` | A short text note for apps and hosts. |
| `channel.socialInteract` | show | `feed set` (on the show) | `podcast:socialInteract` | The post listeners reply to. Written as activitypub https://example.test/@show/1 [@show@example.test]. |
| `channel.chat` | show | `feed set` (on the show) | `podcast:chat` | A live chat room for the show. Written as irc irc.example.test [space]. |
| `channel.value` | show | `feed set` (on the show) | `podcast:value` | A Lightning node that listeners can send to. Written as node-address [name]. |
| `item.funding` | episode | `feed set` | `podcast:funding` | Where listeners can give money. Written as https://example.test/give [message]. |
| `item.license` | episode | `feed set` | `podcast:license` | The license the content is under. Written as cc-by-4.0 [https://example.test/license]. |
| `item.location` | episode | `feed set` | `podcast:location` | The place the content is about. |
| `item.txt` | episode | `feed set` | `podcast:txt` | A short text note for apps and hosts. |
| `item.socialInteract` | episode | `feed set` | `podcast:socialInteract` | The post listeners reply to. Written as activitypub https://example.test/@show/1 [@show@example.test]. |
| `item.chat` | episode | `feed set` | `podcast:chat` | A live chat room for the show. Written as irc irc.example.test [space]. |
| `item.value` | episode | `feed set` | `podcast:value` | A Lightning node that listeners can send to. Written as node-address [name]. |
| `item.alternateEnclosure` | episode | `feed set` | `podcast:alternateEnclosure` | Another file of this episode, such as video. Written as https://example.test/ep.ogg [audio/ogg]. |
| `item.remoteItem` | episode | `feed set` | `podcast:remoteItem` | An episode of another feed this one belongs with. Written as feed-guid [item-guid]. |

`item.pubDate` takes any ISO 8601 date or time: an offset is converted to UTC, a time with no offset is UTC and a bare date is midnight UTC. The pin stores `YYYY-MM-DDTHH:MM:SSZ` and the feed shows it as an RFC 2822 date in GMT. `item.season` and `item.episode` are whole numbers from 1 to 999999.

Show rows (scope `show`) are saved in the show's file, not in the episode ([Shows](#shows)). `channel.mediaUrl` and `channel.person[Name]...` are stored as the show's hosting address and host list rather than as pins. An optional row is absent from the view and the feed until it is set, and never raises a finding for being absent ([Optional elements](#optional-elements)).

## Shows

A show holds what every episode of a podcast shares, so a weekly episode never copies it. Each show is one YAML file, `PODCAST_CONFIG_DIR/shows/<id>.yaml` (default `~/.config/podcast_mcp/shows/`), written by `ShowStore` (`feed/show_store.py`). It holds:

- **pins**: the `channel.*` values a person or agent set, with who set them.
- **roster**: the hosts, each `{name, role, group, img, href}`. Episode people come from the distinct speakers who have dialogue tracks, matched to the roster by name. A speaker who is not on the roster is a guest and gets a warning.
- **media_url**: the hosting address template, such as `https://cdn.example.com/show/{file}`. It is used for the audio, the chapters file, the transcripts, the artwork and the feed address, and it starts empty.
- **ledger**: the episode number of each episode, by guid.

Every change reads the file, edits it and replaces it atomically while holding a lock file beside it (`.<id>.lock`), so two writers (a CLI call and Studio, or two exports) never lose each other's update. A file that cannot be read is named in the error ("The show file the-long-river.yaml cannot be used"); it is never treated as no show: the episode's view lists the blocker with that sentence, offers only a pick among the other shows, and `feed set show <name>` refuses to create a replacement (`feed_show_unreadable`) until the file is fixed or the link is cleared with `feed unset show`.

**Which show an episode belongs to.** The episode stores only a show id (`feed.show_id`).

| Shows on the machine | Episode state |
|---|---|
| exactly one | That show, with no link. |
| none | Pending. `podcast feed set show "The Long River"` creates the show (its id is the name spelled with lowercase letters, digits and hyphens: `the-long-river`) and links the episode to it. |
| two or more, none linked | Pending with a picker. `podcast feed set show the-long-river` links one. |

`feed set show NAME` links an existing show when NAME is its id or spells its id, and creates a show titled NAME otherwise. `feed unset show` unlinks. Linking is one history step, so `history_undo` reverses it.

**Editing a show.** Any `channel.*` key goes to the episode's show with `feed set` (CLI and MCP) or `POST /api/feed/edit`, under the show's lock. A bad value, such as an address that is not https, is refused with `feed_value_invalid` and leaves the file untouched. Setting a value that is already unset, or unsetting one that is not set, writes nothing. With no show yet the answer is `feed_show_missing` and the command to create one. `set show` takes a name or an id; the HTTP edit may add `"link": true` to say the value is an id, and an id that is not in the store is then refused with `feed_show_not_found` instead of creating a show named after it. `POST /api/feed/edit` also takes `by` (`person`, `agent` or `guest`, default `person`) so an undo restores a pin with its first author.

- `channel.mediaUrl` sets the hosting address. It must be https, ASCII and contain `{file}` once.
- `channel.person[Ana Reyes].role`, `.group`, `.img` or `.href` sets one host, adding them with the role `host` when they are new. `channel.person[Ana Reyes]` with a role as its value does the same, and `feed unset channel.person[Ana Reyes]` removes the host.
- `channel.season` is the season every episode is in until an episode sets `item.season` itself.
- `channel.image` is an https address or a `.jpg` / `.png` file on this machine. A file is copied into the export set when the feed is written ([Writing the feed file](#writing-the-feed-file)); until the hosting address exists the row says "Where will this be hosted?".

**Numbers.** Episode numbers are automatic. The first successful write of an episode gives it the next number in its show's ledger (the highest number plus one) and keeps it, so renaming the episode or writing again never renumbers it. Until then `item.episode` reads "Numbered when the feed file is first written." The number lives only in the show's machine-local ledger, not in `episode.sharecut`; a project moved to another machine is numbered by that machine's ledger. Pin `item.episode` to override the number for one episode; the ledger still records its own.

## Writing the feed file

`podcast feed write -p P` (MCP `feed_write`, `POST /api/feed/write`, `FeedService.write`) writes `<name>.feed.xml` into `export/`, beside the audio it names. The file is the channel plus this episode as its one item, which is what podcast hosts import. The bare `<item>` stays a view (`feed show --item`) for people who keep their own feed.

- It is refused while any blocker stands (`feed_blocked`, with the blockers in the message). Nothing is written, and no guid or number is made.
- The first successful write gives the episode its guid (`urn:uuid:...`) and first export time, saves them in `feed`, and takes the episode's number from the show's ledger. They are made once and never re-derived; undoing history never takes them away. The first export time is stored as UTC text (`2026-10-23T09:00:00Z`); a value an editor wrote by hand is normalised to that form when the project loads, and one that is not a date or time is refused.
- The feed file and a copy of the show's artwork file (`<name>.cover.jpg` or `.png`, when `channel.image` names a file) are published together with one atomic replace each, so a reader never sees half a file.
- Writing again with nothing changed touches no file. `file` in the view is `none` when `<name>.feed.xml` does not exist, `current` when it equals what `render` gives now and `stale` otherwise, so an edit to a pin, the chapters or the show makes it stale until the next write.
- The export job writes it. After the audio, transcripts and chapters publish, `export_episode_deliverables` refreshes the feed file when the listing has no blocker. A blocker, a feed file another program holds open or any other failure there is logged and leaves the previous file; it never fails a finished export, and the file then reads as stale.

## Optional elements

The rest of the Apple and Podcasting 2.0 elements are rows you set only when you use them. Each takes one line of text, and the same check that accepts it renders it, so an accepted value always produces valid XML. They never appear in the feed, the view or the findings until set. Three raise an info finding once set, naming the platform's behaviour: `channel.block`, `channel.complete` and `channel.newFeedUrl`.

| Row | Written as | Feed element |
|---|---|---|
| `channel.locked` | `yes` or `no` | `podcast:locked` |
| `channel.type` | `episodic` or `serial` | `itunes:type` |
| `channel.block`, `channel.complete` | `yes` (unset to remove) | `itunes:block`, `itunes:complete` |
| `channel.newFeedUrl` | an https address | `itunes:new-feed-url` |
| `channel.medium` | `podcast`, `music`, `video`, `film`, `audiobook`, `newsletter` or `blog` | `podcast:medium` |
| `channel.updateFrequency` | free text such as `Weekly` | `podcast:updateFrequency` |
| `channel.trailer` | `URL ISO-time Title`, such as `https://example.test/t.mp3 2026-11-01T09:00:00Z Season trailer` | `podcast:trailer` |
| `channel.podroll` | one `feed-guid [feed-url]` per line | `podcast:podroll` with `podcast:remoteItem` |
| `channel.publisher` | `feed-guid [feed-url]` | `podcast:publisher` with `podcast:remoteItem medium="publisher"` (the guid is a UUID) |
| `channel.funding`, `item.funding` | `URL [message]` (the message defaults to "Support the show") | `podcast:funding` |
| `channel.license`, `item.license` | `name [URL]` | `podcast:license` |
| `channel.location`, `item.location` | the place's name | `podcast:location` |
| `channel.txt`, `item.txt` | free text | `podcast:txt` |
| `channel.socialInteract`, `item.socialInteract` | `protocol URI [account-id]` | `podcast:socialInteract` |
| `channel.chat`, `item.chat` | `protocol server [space]` | `podcast:chat` |
| `channel.value`, `item.value` | `node-address [name]` (the node public key in hexadecimal): a Lightning keysend recipient with the whole split | `podcast:value` with `podcast:valueRecipient` |
| `item.alternateEnclosure` | `URL [media-type]` (the type is read from the extension when it is known) | `podcast:alternateEnclosure` with `podcast:source` |
| `item.remoteItem` | `feed-guid [item-guid]` | `podcast:remoteItem` |

`podcast feed fields` lists them all. Studio has no value-for-value interface beyond these rows.

## Findings

Every finding has a severity, the platform it protects, a message and, when one exists, the fix.

- **blocker**: the XML would break RSS 2.0 or the podcast minimum. A missing show, title, description or website, an audio file that was never exported, an export with only a WAV, or no address for the audio file. A blocker never stops the audio export.
- **warn**: a platform will complain. Missing intro, language, category, explicit flag or artwork (Apple), notes over 10,000 characters (Apple) or 4,000 bytes (PSP-1), a soundbite outside 15 to 120 seconds, a speaker listed as a guest (Podcasting 2.0).
- **info**: optional or advisory. A long title (Spotify), no owner email, no episode number, a changed pin, and what a flag does to apps once it is set (`channel.block`, `channel.complete`, `channel.newFeedUrl`).

Findings sort blocker, warn, info.

Before the feed file is first written the episode has no guid. The XML leaves `<guid>` out, and the view says so with an info finding on `item.guid`, "Created when you write the feed file." It never blocks.

## Hosting

One show setting, `channel.mediaUrl`, is a template such as `https://cdn.example.com/show/{file}`. Studio uses it for the audio, the chapters file, the transcripts, the artwork copy and the feed address. An episode can pin a full `item.enclosure.url` instead. The address must be https and ASCII. Until one of them exists the view says "Where will this be hosted?" and the XML leaves the element out. The XML never contains a placeholder address.

Studio looks for these files in `export/`, named after the project: `<name>.mp3` or `.m4a` for the enclosure, `<name>.wav` for the duration, `<name>.vtt` and `<name>.srt` for transcripts and `<name>.feed.xml` for the feed file. A WAV alone is a blocker. The chapters file is not looked for. When the episode has chapters and the hosting address and an exported audio file are known, the feed links to `<name>.chapters.json` at the hosting address, the name the export writes. A feed file that cannot be read as UTF-8 counts as `stale`.

## Feed XML

`podcast feed show --xml` prints a channel with this episode as its one item. `--item` prints the bare `<item>` for people who keep their own feed. Elements appear only when their fact is known. The notes go in `description` and `content:encoded` as CDATA, limited to `p`, `ol`, `ul`, `li` and `a`. Pinned notes become one `<p>` per non-blank line, because a line break (`<br>`) is outside the set podcast apps accept. The file state is `none` when `<name>.feed.xml` does not exist, `current` when it equals what `render` gives now and `stale` otherwise.

## Guests

A guest with an Editor share link edits the episode's listing; a Viewer or Commenter link cannot. `SetFeedField` and `ClearFeedField` are in the Editor command set (`document_sync/capabilities.py`, `EDIT_COMMANDS`), so the guest sends them to `POST /api/review/{token}/daw/document/command` like any other edit, and a Viewer or Commenter gets `share_capability_required`. The payload gate asks the field registry: a guest may name only an episode row a person can pin (never a show setting, a made-once or measured row, or a key the registry does not know), and a guest asking to be an agent is refused with a message that says a share link edits as a person. The server stamps every value a guest sets as `guest`, so the view reads `source.by: "guest"` and the host can tell a guest's value from their own; a host who edits it again takes it back as `person`. A guest never sees the titles of shows the episode is not linked to: where the host sees the picker, the guest's view lists none. Values are checked as for the host, so an https address is the only kind of address a guest can set, and the guest event carries only the command type, never the key, the value or a host path. A guest edit is one history step; an Editor undoes it with `UndoHistory`.

The Deliver stage shows the listing to the host, and an Editor link opens Deliver to the listing alone: it edits episode values, including the episode's own hosting address (`item.enclosure.url`) and people's addresses, edits plain show values and writes the feed file. Creating or choosing the show, the show's hosting template (`channel.mediaUrl`), artwork from a local file and credentials stay with the host. Values a guest set carry a quiet Guest mark.

A share that can view reads the listing with `GET /api/review/{token}/feed`, which returns the same `{view, itemXml}` as `GET /api/feed` and is rate limited like the other guest reads. The guest MCP has no listing tools of its own: its tool list is a fixed allow-list by capability, not one tool per command, so an Editor's agent writes a value with `guest_submit_document_command` (type `SetFeedField`) and reads it over the HTTP route.

## Surfaces

| Surface | Read | Edit |
|---|---|---|
| CLI | `podcast feed show -p P [--json \| --xml \| --item \| --notes \| --shows] [--check [--strict]]`, `podcast feed fields [--json]` | `podcast feed set -p P KEY VALUE` (`@file` reads a file), `podcast feed unset -p P KEY`, `podcast feed write -p P` |
| MCP | `feed_read(project_path, view)` with `view` one of `facts`, `item_xml`, `feed_xml`, `notes_html`, `show` | `feed_set(project_path, field, value)`, `feed_unset(project_path, field)`, `feed_write(project_path)`. Agent pins are marked `agent`. |
| HTTP | `GET /api/feed?path=` returns `{view, itemXml}`; guests: `GET /api/review/{token}/feed` | `POST /api/feed/edit` with `{path, edit}` where `edit` is `{op: "set", key, value}` or `{op: "unset", key}`; `POST /api/feed/write` with `{path}` returns the same `{view, itemXml}` (400 `feed_blocked` while a blocker stands) |

`--check` exits 1 when a blocker stands. `--xml` prints the file and then, while a blocker stands, warns on stderr and exits 1, so a script cannot save an invalid feed unnoticed; `--item` is never held back. A `@file` that cannot be read as UTF-8 text is `feed_file_unreadable`. An unknown MCP `view` is `feed_view_unknown`. `feed_set` takes text, a number or true/false for `value`; `2` and `"2"` are the same. `--strict` also fails on warnings and changed pins. The `/api/feed` routes require the host role, except two routes an Editor share link may call, both returning the same `{view, itemXml}`: `POST /api/review/{token}/feed/write` (writes the file) and `POST /api/review/{token}/feed/edit` with `{edit}` (one plain show value such as `channel.title`, `channel.author`, `channel.owner.email` or a host's role). Episode values reach a guest through the document command route. Creating or linking a show, `channel.mediaUrl` and artwork given as a file path stay host-only; an Editor can set artwork only as an https address. A failed publish (a locked or unwritable export folder) is `feed_write_failed`. The capability rows are `daw.feed.read`, `daw.feed.edit` and `daw.feed.write`; the skill is `podcast-rss-feed`.

Each feed command reports a progress phase (`read`, `edit`, `check`, `identity`, `write`, `fields`) on the task the CLI or MCP adapter opened, so a long wait on a locked show or export directory shows what it is doing ([progress.md](progress.md)). They are listed in `contracts/progress-richness.json`.

An agent writes the episode intro with `feed_set(project_path, "item.intro", text)`. See [the skill](../.agents/skills/podcast-rss-feed/SKILL.md).

## Where it lives

| Piece | Path |
|---|---|
| Registry, rules, resolver, XML | `src/podcast_mcp/feed/` (`fields.py`, `extras.py` for the optional elements, `resolve.py`, `render.py`, `notes.py`) |
| Show files and their lock | `src/podcast_mcp/feed/show_store.py` ([persistence](persistence.md)) |
| Gathering inputs, writing the feed file | `src/podcast_mcp/feed/inputs.py`, `src/podcast_mcp/feed/writer.py` |
| Persisted shape | `src/podcast_mcp/models/feed.py`, `EpisodeProject.feed` ([episode format](episode-format-v2.md#feed)) |
| Service | `src/podcast_mcp/services/document/feed.py` |
| Document commands | `SetFeedField`, `ClearFeedField` ([session sync](session-sync.md#document-plane-api)) |
| Adapters | `cli/feed.py`, `mcp/tools/feed.py`, `gui/routes/feed_routes.py`, `gui/routes/review_share.py` (the Editor routes) |
| Export hook | `export/episode.py` calls `feed.writer.write_after_export` |
