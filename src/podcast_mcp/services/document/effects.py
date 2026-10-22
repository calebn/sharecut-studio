"""Track effect-chain operations of the analysis service."""

from __future__ import annotations

from typing import Any

from podcast_mcp.effects.presets import (
    add_effect,
    apply_specs_to_chain,
    get_preset,
    list_presets,
    list_track_effects,
    remove_effect,
    set_effect_bypass,
)
from podcast_mcp.engines.effect_filters import is_supported_effect, supported_effect_names
from podcast_mcp.services.document.service_base import WorkspaceService
from podcast_mcp.util.coded_error import CodedValueError


class EffectsService(WorkspaceService):
    def add_effect(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        preset: str | None = None,
        effect: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        specs = get_preset(preset, defaults=self.ws.effective_config()) if preset else None
        requested = (
            [spec["effect"] for spec in specs]
            if specs is not None
            else ([effect] if effect else [])
        )
        unsupported = [name for name in requested if not is_supported_effect(name)]
        if unsupported:
            supported = ", ".join(supported_effect_names())
            names = ", ".join(f"'{name}'" for name in unsupported)
            raise CodedValueError(
                f"unsupported effect {names}; supported effects: {supported}",
                code="unsupported_effect",
            )

        def mutate(p) -> dict:
            if preset and specs is not None:
                chain = apply_specs_to_chain(p, tid, specs)
            elif effect:
                chain = add_effect(p, tid, effect, params)
            else:
                raise CodedValueError("preset or effect is required", code="effect_required")
            return {"track_id": tid, "effects": [e.model_dump() for e in chain.effects]}

        return self.ws.mutate("before add effect", "after add effect", mutate)

    def remove_effect(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        effect: str | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker)

        def mutate(p) -> dict:
            removed = remove_effect(p, tid, effect)
            return {"track_id": tid, "removed": removed}

        return self.ws.mutate("before remove effect", "after remove effect", mutate)

    def set_effect_bypass(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        effect_index: int,
        bypass: bool,
    ) -> dict:
        tid = self._resolve(track_id, speaker)
        return self.ws.mutate(
            "before set effect bypass",
            "after set effect bypass",
            lambda p: set_effect_bypass(p, tid, effect_index, bypass),
            operation="set_effect_bypass",
            params={
                "track_id": tid,
                "effect_index": effect_index,
                "bypass": bypass,
            },
        )

    def list_effects(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
    ) -> dict:
        tid = self._resolve(track_id, speaker) if (track_id or speaker) else None
        if tid:
            return {
                "track_id": tid,
                "effects": list_track_effects(self.ws.project, tid),
                "supported_effects": list(supported_effect_names()),
            }
        return {
            "presets": list_presets(defaults=self.ws.effective_config()),
            "supported_effects": list(supported_effect_names()),
        }
