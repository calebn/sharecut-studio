"""Real lab windows with filler and pause labels from the lab's seeded ASR.

Labels are ``label_source: "asr_seed"``: faster-whisper ``base`` words from the
lab's ``source/asr`` seed. No person has listened to confirm them, and the
committed audio contradicts some of them (see README.md).
"""

from __future__ import annotations

VERSION = 1
LAB_REVISION = "3b414c4c86aa46b058d0505d3e0fb2092a6a959f"
FILLER_TOKENS = ("uh", "um")
MIN_PAUSE_SEC = 1.2
SOURCE_FILES = {
    "caleb": {
        "filename": "audioCalebNelson11599985973.m4a",
        "sha256": "e4c722e1912e46cd4b26a5ad033ce28da0a2ef426c934ae2df92ac2d2f9c1fd2",
        "sample_rate": 48000,
        "channels": 2,
        "sample_format": "s16",
        "frames": 81099776,
    },
    "audra": {
        "filename": "audioAudraHowerton31599985973.m4a",
        "sha256": "25f3b30d7178dcb328087706ec8a4031654f04637cfd06e7f7843cc1ef556f9a",
        "sample_rate": 48000,
        "channels": 2,
        "sample_format": "s16",
        "frames": 81099776,
    },
    "lana": {
        "filename": "audioLanaAileenBurke21599985973.m4a",
        "sha256": "23ff688ca9877d52ac99b11af39a95db1f9f4901a226087d480b0661bbade7b3",
        "sample_rate": 48000,
        "channels": 2,
        "sample_format": "s16",
        "frames": 81099776,
    },
}
ASR_FILES = {
    "caleb": {
        "filename": "caleb.json",
        "sha256": "68a1b092862ad1a510fd285b19c67165bfe554ee749558fbc889b2fbdc5ba1b8",
    },
    "audra": {
        "filename": "audra.json",
        "sha256": "a02ea4ecd266c9cc5115be887218c3cfe047483ef4594ace405d51b415406a27",
    },
    "lana": {
        "filename": "lana.json",
        "sha256": "57fbfed13538837a80ecbe43125de57020e513e5d671e5f16a7446b4d417e694",
    },
}
TRACK_LABELS = {"caleb": "Caleb", "audra": "Audra", "lana": "Lana"}

CASES = (
    {
        "name": "lana_uh_cluster",
        "source_interval": (1108.0, 1133.0),
        "labels": (
            {
                "kind": "filler",
                "track": "lana",
                "source_interval": (1109.04, 1110.44),
                "text": "Uh",
                "label_source": "asr_seed",
            },
            {
                "kind": "pause",
                "track": "caleb",
                "source_interval": (1109.34, 1114.16),
                "text": "file. ... Okay.",
                "label_source": "asr_seed",
            },
            {
                "kind": "pause",
                "track": "lana",
                "source_interval": (1110.56, 1114.6),
                "text": "-huh. ... Uh",
                "label_source": "asr_seed",
            },
            {
                "kind": "filler",
                "track": "lana",
                "source_interval": (1114.6, 1116.0),
                "text": "Uh",
                "label_source": "asr_seed",
            },
            {
                "kind": "pause",
                "track": "caleb",
                "source_interval": (1114.66, 1118.44),
                "text": "Okay. ... I'm",
                "label_source": "asr_seed",
            },
            {
                "kind": "pause",
                "track": "lana",
                "source_interval": (1116.24, 1121.26),
                "text": "-huh. ... Uh",
                "label_source": "asr_seed",
            },
            {
                "kind": "filler",
                "track": "lana",
                "source_interval": (1121.26, 1122.66),
                "text": "Uh",
                "label_source": "asr_seed",
            },
            {
                "kind": "pause",
                "track": "caleb",
                "source_interval": (1121.46, 1122.92),
                "text": "microphone. ... Okay.",
                "label_source": "asr_seed",
            },
            {
                "kind": "pause",
                "track": "lana",
                "source_interval": (1122.78, 1124.56),
                "text": "-huh. ... Uh",
                "label_source": "asr_seed",
            },
            {
                "kind": "filler",
                "track": "lana",
                "source_interval": (1124.56, 1125.96),
                "text": "Uh",
                "label_source": "asr_seed",
            },
            {
                "kind": "filler",
                "track": "lana",
                "source_interval": (1125.96, 1125.96),
                "text": "Uh",
                "label_source": "asr_seed",
            },
        ),
        "audio": {
            "caleb": {
                "file": "lana_uh_cluster/raw/caleb.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 1200000,
                "pcm_sha256": "ce3fb8f1be86d02b8792d16ee1ac6bbfedc512074c6ca4917226b591abd2c924",
                "file_sha256": "ebc1e3a8b411720342a010a8092242ed95edf218046c05388d2399135f4be962",
            },
            "audra": {
                "file": "lana_uh_cluster/raw/audra.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 1200000,
                "pcm_sha256": "4b7d379db929e2e255e0f4b7f20d2cd58b631f632a77ec39b6cf9d0b9464ba52",
                "file_sha256": "57728b1eb6f6c069da935e025057d594166c46d2d6fa258fd7cb3f31091e4cd6",
            },
            "lana": {
                "file": "lana_uh_cluster/raw/lana.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 1200000,
                "pcm_sha256": "a20c057ff6d186bf6c2f0eecc4dc7bb35a4c6527e52328940b60c700c050b6e7",
                "file_sha256": "4ad5b1808a66ad4a33e6221b35c3acfea7bfbea4cab3ad6f2ebb010d89c55f00",
            },
        },
    },
    {
        "name": "caleb_um_pause",
        "source_interval": (608.0, 633.0),
        "labels": (
            {
                "kind": "pause",
                "track": "caleb",
                "source_interval": (614.38, 615.98),
                "text": "soon. ... Um.",
                "label_source": "asr_seed",
            },
            {
                "kind": "filler",
                "track": "caleb",
                "source_interval": (615.98, 616.3),
                "text": "Um.",
                "label_source": "asr_seed",
            },
            {
                "kind": "pause",
                "track": "caleb",
                "source_interval": (616.3, 620.26),
                "text": "Um. ... Room,",
                "label_source": "asr_seed",
            },
            {
                "kind": "pause",
                "track": "caleb",
                "source_interval": (620.62, 623.76),
                "text": "Room, ... don't,",
                "label_source": "asr_seed",
            },
            {
                "kind": "pause",
                "track": "caleb",
                "source_interval": (625.42, 628.38),
                "text": "don't. ... Okay.",
                "label_source": "asr_seed",
            },
        ),
        "audio": {
            "caleb": {
                "file": "caleb_um_pause/raw/caleb.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 1200000,
                "pcm_sha256": "d131b82285684c7c00c01b396f301bc6f70596fdfaf96571c9acaeebb66ed830",
                "file_sha256": "80b5a968b86d16ee2cc71f0a74fd18ab8acfe4d090cbf27b2ef1cb3e2b3347af",
            },
            "audra": {
                "file": "caleb_um_pause/raw/audra.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 1200000,
                "pcm_sha256": "e86ab859547825faae683123895e636223e51c00da598c06d7eb95296c9ba728",
                "file_sha256": "16690528ba572bfe787bfa9890d0044fa0a3ace11feb6a7e345e7d85025aa0d1",
            },
            "lana": {
                "file": "caleb_um_pause/raw/lana.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 1200000,
                "pcm_sha256": "f31ef6debd9b097fb4ac082d5ad734c22171457ed75264f2038824f2fc5c195f",
                "file_sha256": "1fdd8ddb5ba682af488bceec6baab174a633f57fc0e5dac7fc99e95fd75c1bb3",
            },
        },
    },
)
