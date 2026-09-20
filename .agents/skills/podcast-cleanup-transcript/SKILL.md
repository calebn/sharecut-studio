---
name: podcast-cleanup-transcript
description: >-
  Deprecated alias — use podcast-transcript-workflow (hub) and podcast-transcript-refine
  (agent text fixes). Kept for backward compatibility with existing references.
---

# Cleanup transcript (redirect)

This skill was split into layered workflows. Use instead:

| Need | Skill |
|------|-------|
| **Where to start / pipeline order** | [podcast-transcript-workflow](../podcast-transcript-workflow/SKILL.md) |
| **Bleed / audibility suppress** | [podcast-transcript-reconcile](../podcast-transcript-reconcile/SKILL.md) |
| **Glossary / cross-track rules** | [podcast-transcript-precorrect](../podcast-transcript-precorrect/SKILL.md) |
| **Interactive text cleanup** | [podcast-transcript-refine](../podcast-transcript-refine/SKILL.md) |
| **One ambiguous span, listen-first** | [podcast-transcript-audition](../podcast-transcript-audition/SKILL.md) |
| **Single word fix** | [podcast-transcript-correct](../podcast-transcript-correct/SKILL.md) |

Canonical doc: [docs/transcript-workflow.md](../../docs/transcript-workflow.md).
