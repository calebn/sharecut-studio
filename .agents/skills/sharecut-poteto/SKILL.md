---
name: sharecut-poteto
description: Use for Sharecut repository contributor work, issue implementation, review, PR delivery, or shipping with the installed native poteto-mode skill. Supplies repository Git and claim policy. For episode operations, use the relevant podcast skill.
---

# Sharecut Poteto companion

1. Resolve the active checkout with `git rev-parse --show-toplevel`. Read its
   `AGENTS.md` and the applicable engineering, UI, security, and product rules.
   Resolve repository paths from that checkout, including after a global skill install.
2. Read [Git policy](references/git-workflow.md) and
   [issue claims](references/issue-claims.md) from this companion.
3. Discover the installed native `poteto-mode` through the harness skill catalog.
   If the catalog exposes filesystem skills, check the active harness's user-skill
   directories. These include `~/.agents/skills/`, `~/.codex/skills/`,
   `~/.claude/skills/`, `~/.cursor/skills/`, and `~/.pi/agent/skills/`.
   Read the discovered `poteto-mode/SKILL.md` in full, including Principles and Harness.
   Read its model configuration when the native instructions require it.
   If native Poteto is absent, report the missing dependency and stop contributor
   execution. Do not substitute another workflow or vendor upstream files here.
4. Route the user's request through native Poteto. Read each selected native
   playbook and routed skill from the discovered installation. Resolve native
   relative paths against that installation, including upstream-source audit paths
   that name another repository. Do not create a local copy of that repository layout.
   Native Poteto owns the procedure, delegation, review, feedback, and Shipping.
   Apply this repository's draft-PR and rebase-merge overrides.
5. Keep the applicable podcast, Impeccable, and product skills active.
   Select the least expensive capable verified runtime model and reasoning effort
   for each role. Follow the operator's model restrictions and assess a specific
   capability need before choosing a premium model. Record the choice and reason.
   Preserve independent native review seats. Do not choose an expensive model
   automatically for a panel. Reuse valid evidence that still covers the current head.
   Use Standard service when available. Do not use Fast service unless requested.
   Do not claim a service tier or execution model the harness does not expose.

The native workflow does not grant permission to merge. Follow the user's current
grant and the repository gates before any external write or merge.
