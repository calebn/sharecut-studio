from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.media.bounce import (
        BounceRequest,
        BounceService,
    )
    from podcast_mcp.services.media.ingest import (
        IngestService,
        import_folder_report_to_dict,
        suggest_alignment_for_manifest,
        suggest_result_to_dict,
        verify_result_to_dict,
        write_alignment_report,
    )
    from podcast_mcp.services.media.media_store import (
        ensure_audio_in_workspace,
        gui_media_chunk_max_bytes,
        gui_media_max_bytes,
        unique_raw_path,
        write_upload_chunk,
    )
    from podcast_mcp.services.media.proxy_media import (
        delete_all_proxies_if_unused,
        ensure_and_upload_all_proxies,
        ensure_track_proxy,
        local_proxy_chunk_path,
        presigned_proxy_urls,
    )
    from podcast_mcp.services.media.review_media import (
        delete_object_store_object_if_unused,
        media_type_for_path,
        presigned_review_audio_url,
        review_guest_audio_path,
        upload_review_version_to_object_store,
    )
    from podcast_mcp.services.media.speaker import (
        SpeakerService,
    )
    from podcast_mcp.services.media.transcript import (
        TranscriptService,
    )
    from podcast_mcp.services.media.transcript_precorrect import (
        TranscriptContextBusyError,
        TranscriptPrecorrectService,
        VocabularyConflictError,
    )
    from podcast_mcp.services.media.transcript_refine import (
        TranscriptRefineService,
    )
    from podcast_mcp.services.media.waveform import (
        StaleWaveformKeyError,
        WaveformBusyError,
        live_key,
        media_index,
        pcm_block,
        schedule_stem_waveforms,
        schedule_track_waveforms,
        tile_bytes,
        waveform_status,
    )

__all__ = [
    "BounceRequest",
    "BounceService",
    "IngestService",
    "SpeakerService",
    "StaleWaveformKeyError",
    "TranscriptContextBusyError",
    "TranscriptPrecorrectService",
    "TranscriptRefineService",
    "TranscriptService",
    "VocabularyConflictError",
    "WaveformBusyError",
    "delete_all_proxies_if_unused",
    "delete_object_store_object_if_unused",
    "ensure_and_upload_all_proxies",
    "ensure_audio_in_workspace",
    "ensure_track_proxy",
    "gui_media_chunk_max_bytes",
    "gui_media_max_bytes",
    "import_folder_report_to_dict",
    "live_key",
    "local_proxy_chunk_path",
    "media_index",
    "media_type_for_path",
    "pcm_block",
    "presigned_proxy_urls",
    "presigned_review_audio_url",
    "review_guest_audio_path",
    "schedule_stem_waveforms",
    "schedule_track_waveforms",
    "suggest_alignment_for_manifest",
    "suggest_result_to_dict",
    "tile_bytes",
    "unique_raw_path",
    "upload_review_version_to_object_store",
    "verify_result_to_dict",
    "waveform_status",
    "write_alignment_report",
    "write_upload_chunk",
]

_MODULE_BY_NAME = {
    "BounceRequest": "bounce",
    "BounceService": "bounce",
    "IngestService": "ingest",
    "import_folder_report_to_dict": "ingest",
    "suggest_alignment_for_manifest": "ingest",
    "suggest_result_to_dict": "ingest",
    "verify_result_to_dict": "ingest",
    "write_alignment_report": "ingest",
    "ensure_audio_in_workspace": "media_store",
    "gui_media_chunk_max_bytes": "media_store",
    "gui_media_max_bytes": "media_store",
    "write_upload_chunk": "media_store",
    "unique_raw_path": "media_store",
    "ensure_and_upload_all_proxies": "proxy_media",
    "delete_all_proxies_if_unused": "proxy_media",
    "ensure_track_proxy": "proxy_media",
    "presigned_proxy_urls": "proxy_media",
    "local_proxy_chunk_path": "proxy_media",
    "media_type_for_path": "review_media",
    "delete_object_store_object_if_unused": "review_media",
    "review_guest_audio_path": "review_media",
    "upload_review_version_to_object_store": "review_media",
    "presigned_review_audio_url": "review_media",
    "SpeakerService": "speaker",
    "TranscriptService": "transcript",
    "TranscriptContextBusyError": "transcript_precorrect",
    "TranscriptPrecorrectService": "transcript_precorrect",
    "VocabularyConflictError": "transcript_precorrect",
    "TranscriptRefineService": "transcript_refine",
    "StaleWaveformKeyError": "waveform",
    "WaveformBusyError": "waveform",
    "pcm_block": "waveform",
    "tile_bytes": "waveform",
    "waveform_status": "waveform",
    "schedule_track_waveforms": "waveform",
    "schedule_stem_waveforms": "waveform",
    "live_key": "waveform",
    "media_index": "waveform",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
