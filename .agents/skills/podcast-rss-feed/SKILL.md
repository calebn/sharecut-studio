---
name: podcast-rss-feed
description: >-
  Read an episode's podcast listing (show notes, chapters, people, hosting
  address, what the RSS feed still needs) and write its intro line. Use when the
  user wants show notes, an episode description, the RSS item or feed XML, to
  set up or edit the podcast's show details, to write the feed file, or asks
  what is missing before publishing. Not chapter editing (use
  podcast-chapter-markers) or transcript exports (use podcast-transcript-workflow).
---

# Podcast listing

The listing is computed on every read from the project, `export/` and the episode's show. Episode edits are stored as pins on `episode.sharecut`; what every episode of a show shares is stored in the show's file (`~/.config/podcast_mcp/shows/<id>.yaml`). See [docs/podcast-feed.md](../../../docs/podcast-feed.md).

## Tools

| Tool | CLI | Use |
|------|-----|-----|
| `feed_read(project_path, view)` | `podcast feed show -p P [--json \| --xml \| --item \| --notes \| --check]` | `facts` (default) is JSON; `notes_html`, `item_xml`, `feed_xml` and `show` are the other views |
| `feed_set(project_path, field, value)` | `podcast feed set -p P KEY VALUE` | Pin one value. Empty or blank text unsets. A number or true/false is read as text |
| `feed_unset(project_path, field)` | `podcast feed unset -p P KEY` | Go back to the automatic value |
| `feed_write(project_path)` | `podcast feed write -p P` | Write `<name>.feed.xml` next to the exported audio. Refused while a blocker stands; a second call writes nothing |
| | `podcast feed fields` | Every key, how it is edited and which feed tags it feeds |

Each episode edit is one undo step: `history_undo` reverses it. Show values (`channel.*`) are saved in the show file and are not part of the episode's history.

## Set up the show

Do this once per podcast, and only with the person's words for each value. Never invent a title, description, owner email or hosting address.

1. `feed_read(project_path, "show")`. `kind: none` means no show yet: ask the person for the show's name, then `feed_set(project_path, "show", name)`. It creates the show and links the episode. `kind: choose` lists the shows on this machine: ask which, then `feed_set(project_path, "show", id)`. `kind: ready` needs nothing.
2. Fill the rows the findings name, one `feed_set` each: `channel.description`, `channel.link`, `channel.category`, `channel.explicit`, `channel.author`, `channel.owner.name`, `channel.owner.email`, `channel.image` (an https address or a `.jpg` / `.png` path on this machine).
3. Ask where files will be hosted and set `channel.mediaUrl` to the address with `{file}` where the file name goes, for example `https://cdn.example.com/show/{file}`.
4. Name the hosts the way they appear as speakers: `feed_set(project_path, "channel.person[Ana Reyes].role", "host")`, then `.href` or `.img` if the person gives them. A speaker who is not on the list is a guest.
5. Optional rows (`channel.funding`, `channel.license`, `channel.locked`, `channel.medium`, `item.funding` and the rest of `podcast feed fields`) are set only when the person asks for them.

Episode numbers are automatic: the first `feed_write` of an episode takes the show's next number. Set `item.season` or `channel.season` only when the person gives one.

## Write the feed file

`feed_read` first. When no finding is a `blocker`, `feed_write(project_path)` writes the file and the export job keeps it current. A `blocker` names what is missing (the hosting address, an exported MP3, the show details); fix those, not the file. `file` in the view says `stale` when the file no longer matches the listing.

## Write the intro

The intro is the one value only a person or agent can supply. It leads the show notes and is Apple's episode description.

1. `feed_read(project_path)` and look at `item.intro`. If it is pending, read the chapters (`sections.chapters`), the people (`sections.credits`) and, when the transcript is the only source, `get_transcript` or `search_transcript_tool` for what the episode covers.
2. Write one or two plain sentences about this episode. No HTML, no markdown, no timestamps, no host or show name unless it matters to the topic. Keep it under about 300 characters.
3. `feed_set(project_path, "item.intro", text)`. It is marked as an agent pin so the person can see who wrote it and change it.
4. `feed_read(project_path, "notes_html")` to show the person the notes it produced. Tell them they can edit the intro or `feed_unset` it.

Do not set `item.notes` to write an intro: that pins the entire notes text and stops the chapters and credits updating. Use it only when the person asks for hand-written notes.

## Read what is missing

`findings` lists blockers, warnings and info, each with the platform it protects and a `fix`:

- `edit`: a ready edit. Send it with `feed_set` or `feed_unset`.
- `input`: a value only the person can give for that key, such as the hosting address. Ask them, then `feed_set`.
- `command`: a step outside the listing, such as `export_episode`. Run the export (`export_audio_tool`) or tell the person.

A pin with `drifted: true` means the automatic value changed after it was set (for example the chapters changed after the notes were pinned). Ask the person: keep theirs (`feed_set` the same value again) or take the new one (`feed_unset`).

## Do not edit here

Chapters, clips, speakers and transcripts are edited where they live (`add_chapter_tool`, the clip and speaker tools, the Transcript export). The listing only reads them. The guid, file size and duration are made or measured and cannot be set.
