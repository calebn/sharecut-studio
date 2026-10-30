---
name: podcast-rss-feed
description: >-
  Read an episode's podcast listing (show notes, chapters, people, hosting
  address, what the RSS feed still needs) and write its intro line. Use when the
  user wants show notes, an episode description, the RSS item or feed XML, or
  asks what is missing before publishing. Not chapter editing (use
  podcast-chapter-markers) or transcript exports (use podcast-transcript-workflow).
---

# Podcast listing

The listing is computed on every read from the project and `export/`. Only edits are stored, as pins on `episode.sharecut`. See [docs/podcast-feed.md](../../../docs/podcast-feed.md).

## Tools

| Tool | CLI | Use |
|------|-----|-----|
| `feed_read(project_path, view)` | `podcast feed show -p P [--json \| --xml \| --item \| --notes \| --check]` | `facts` (default) is JSON; `notes_html`, `item_xml`, `feed_xml` and `show` are the other views |
| `feed_set(project_path, field, value)` | `podcast feed set -p P KEY VALUE` | Pin one value. The empty string unsets |
| `feed_unset(project_path, field)` | `podcast feed unset -p P KEY` | Go back to the automatic value |
| | `podcast feed fields` | Every key, how it is edited and which feed tags it feeds |

Each edit is one undo step: `history_undo` reverses it.

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

Chapters, clips, speakers and transcripts are edited where they live (`add_chapter_tool`, the clip and speaker tools, the Transcript export). The listing only reads them. Show settings (title, description, category, artwork, hosting address, hosts) need the show store, which is not available yet; `feed_set` on a `channel.*` key replies `feed_show_unavailable`.
