"""The podcast listing: facts resolved from an episode, edits as pins, and the feed XML.

``resolve`` and ``render`` are pure. ``services.document.FeedService`` gathers the inputs
and applies edits; the CLI, MCP and GUI adapters only call it.
"""
