from __future__ import annotations

VERSION = 1
CLIP_PADDING_SEC = 0.05
LAB_REVISION = "3b414c4c86aa46b058d0505d3e0fb2092a6a959f"
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

CASES = (
    {
        "name": "audra_only_intro",
        "source_interval": (1340.3, 1343.0),
        "historical_reviewed_timeline_interval": (6.8, 9.5),
        "tracks": ("audra", "caleb"),
        "labels": (
            {
                "speaker": "owner",
                "provenance": "original owner review",
                "text": "I hear none of caleb's vocals in the second half, it's just audra saying \"and it's me audra\"",
            },
        ),
        "ownership": "Audra-only receiving lane verified; no Caleb vocals heard in the second half.",
        "mute": {"track": "caleb", "scope": "full reviewed interval", "interval": (6.8, 9.5)},
        "audio": {
            "caleb": {
                "file": "audra_only_intro-caleb.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 134400,
                "pcm_sha256": "0d4af88b6a554d9daf2954f1aa349c5711017d0b3261fefeae158a52ad3e2c9d",
                "file_sha256": "23bc2ba1e59a584c25e5893691f96b5733c4de504d5874ff87db7540ce2085fc",
            },
            "audra": {
                "file": "audra_only_intro-audra.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 134400,
                "pcm_sha256": "e210e47264f9b0d4e2c504a4be65803ee67b0e69675b59c01fc2e975f57c73ee",
                "file_sha256": "b8fabcc6ad9f13de821e3512671bf9a23a33d6dc747cc15048c1491768fa1cc2",
            },
        },
    },
    {
        "name": "caleb_direct",
        "source_interval": (1506.84, 1509.84),
        "historical_reviewed_timeline_interval": (100.0, 103.0),
        "tracks": ("audra", "caleb"),
        "labels": (
            {
                "speaker": "owner",
                "provenance": "original/final mixed direct-Caleb speech control",
                "text": "yes, intact",
            },
        ),
        "ownership": "Direct Caleb speech in mixed audio; this does not label an isolated raw track or numeric breath boundary.",
        "mute": None,
        "audio": {
            "caleb": {
                "file": "caleb_direct-caleb.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 148800,
                "pcm_sha256": "619c6c3358d9eb66117285098e67ce2ea4f4c42608fa00f44eef75229a87a104",
                "file_sha256": "6de07dbe049a918ccf181d27919228dfb8b79451023058bdbbebafe8ef8a3c71",
            },
            "audra": {
                "file": "caleb_direct-audra.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 148800,
                "pcm_sha256": "ec409327389176b36b1eb1fc632561884903d841afbe910c1742e127393ab4d4",
                "file_sha256": "2191082d0dbae682294c7bfe9abb4980bae475924c29d0c40c08711ca58c8f53",
            },
        },
    },
    {
        "name": "audra_lana_overlap",
        "source_interval": (1652.4, 1657.0),
        "historical_reviewed_timeline_interval": (151.0, 155.6),
        "tracks": ("audra", "caleb", "lana"),
        "labels": (
            {
                "speaker": "owner",
                "provenance": "mixed listening review",
                "text": "the second one I can hear Lana slightly talking over her but no echo",
            },
            {
                "speaker": "owner",
                "provenance": "raw Caleb-track listening review",
                "text": "still no audible caleb speech",
            },
            {
                "speaker": "owner",
                "provenance": "fresh full-mute listening review",
                "text": "yes, that's right",
            },
        ),
        "ownership": "Audra and Lana overlap in mixed audio; raw Caleb track has no audible Caleb speech per owner review.",
        "mute": {"track": "caleb", "scope": "full reviewed interval", "interval": (151.0, 155.6)},
        "audio": {
            "caleb": {
                "file": "audra_lana_overlap-caleb.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 225600,
                "pcm_sha256": "8a44815cfd3f4c2734d3a969f52d5a1336548e09d15c3c34d74e63e7ab1cd967",
                "file_sha256": "4954cb44d7cb1f67bdeeac26b017727a7b4b1ff44b2c57b9e9802a8f913aae83",
            },
            "audra": {
                "file": "audra_lana_overlap-audra.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 225600,
                "pcm_sha256": "cec44bb0c11647c5fa56e796bff279e6ffaecfffb2af0102ac942df5728acf40",
                "file_sha256": "9deab4e91c9ba3e4d61665173ec39aa34cbd2b3d44ee754648aaea053b4a95b8",
            },
            "lana": {
                "file": "audra_lana_overlap-lana.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 225600,
                "pcm_sha256": "f0de7c1cd7ed6075aa00b60274c352af15dbfc71796433e03df1912a619dc321",
                "file_sha256": "fcd29f11fdd6260b9d2197cc93c0738793fcb687f550039b94b5bdbe41489b04",
            },
        },
    },
    {
        "name": "unwanted_mic_noise",
        "source_interval": (1682.4, 1686.4),
        "historical_reviewed_timeline_interval": (181.0, 185.0),
        "tracks": ("audra", "caleb"),
        "labels": (
            {
                "speaker": "owner",
                "provenance": "listening review",
                "text": "no vocals in the second half, more non-verbal bumps or something the mic is picking up, nothing to keep",
            },
        ),
        "ownership": "Unwanted non-verbal receiving noise; no foreign speaker is confirmed.",
        "mute": {"track": "caleb", "scope": "full reviewed interval", "interval": (181.0, 185.0)},
        "audio": {
            "caleb": {
                "file": "unwanted_mic_noise-caleb.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 196800,
                "pcm_sha256": "9a1fa85768cdc1a96d20d72c0d26428378f61a1c5e15ef733b8795a912a4e3ec",
                "file_sha256": "3f04132c886a611eb8db9eb839bb4360df712ccefda2e6175cf6015e490c068f",
            },
            "audra": {
                "file": "unwanted_mic_noise-audra.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 196800,
                "pcm_sha256": "8a7721e59e51bb30c4c2c6883be7fd95e54f89ac627241eddfff30f544d1bd24",
                "file_sha256": "7584f54226e94e264b355a1ecf00a01b71d08bc495aac725fc8308c6f611dbfe",
            },
        },
    },
    {
        "name": "observed_sound_not_to_keep",
        "source_interval": (1633.4, 1636.4),
        "historical_reviewed_timeline_interval": (132.0, 135.0),
        "tracks": ("audra", "caleb"),
        "labels": (
            {
                "speaker": "owner",
                "provenance": "earlier owner observation",
                "text": "I think I hear a caleb inhale at the very end",
            },
            {
                "speaker": "owner",
                "provenance": "owner correction and explicit edit intent",
                "text": "no, those sounds were not worth keeping, i was just noting that I heard them",
            },
            {
                "speaker": "owner",
                "provenance": "owner correction and explicit edit intent",
                "text": "eliminating those bumps and other sounds is the right call, not preserving them",
            },
        ),
        "ownership": "Speaker identity is uncertain. The earlier inhale observation is corrected as non-verbal sounds not worth keeping, not a confirmed or desirable owner-breath positive.",
        "mute": {"track": "caleb", "scope": "full reviewed interval", "interval": (132.0, 135.0)},
        "audio": {
            "caleb": {
                "file": "observed_sound_not_to_keep-caleb.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 148800,
                "pcm_sha256": "261ddd80f69b73b85c97fda0ff4819a04ecb43c0e0a24f9d0a5617fb46da9a22",
                "file_sha256": "ce22260bed8ca2526a1dcdb49e755d9440123cf0fd63d5b0f4d29eef3f46e9d9",
            },
            "audra": {
                "file": "observed_sound_not_to_keep-audra.flac",
                "sample_rate": 48000,
                "channels": 2,
                "sample_format": "s16",
                "frames": 148800,
                "pcm_sha256": "4eac9d38595f86a2fcb86dba21ad69d49b7f440b1d3ef3a54052a1b946f0a87e",
                "file_sha256": "7e5bd9e369edf530a6239af800ace4bea801c64ebe0b36c6732b92f41bb89043",
            },
        },
    },
)
