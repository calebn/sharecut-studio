This directory holds the generated iOS payload: `Python.xcframework`, `FFmpeg.xcframework`, `Whisper.xcframework`, `app_packages` and the manifest.
Everything here except this file is gitignored.
`gui/desktop/src-tauri/ios/project.yml` links the xcframeworks and `app_packages` from this directory, so the directory name has to stay in the tree.

- `Python.xcframework`, `app_packages` and the manifest: `scripts/ios/build_payload.py`.
- `FFmpeg.xcframework`: `make ios-ffmpeg-device` and `make ios-ffmpeg-sim` each run `scripts/ios/build_ffmpeg.sh` for one slice, then `scripts/ios/ffmpeg_framework.py assemble`; `make ios-ffmpeg` runs both.
- `Whisper.xcframework` (whisper.cpp, the iPhone transcription engine): `make ios-whisper-device` and `make ios-whisper-sim` each run `scripts/ios/build_whisper.sh` for one slice, then `scripts/ios/ffmpeg_framework.py --framework whisper assemble`; `make ios-whisper` runs both. The slices are read from `gui/desktop/src-tauri/ios-whisper/out/<device|sim>/Whisper.framework`, and the glue and patches live in `gui/desktop/src-tauri/ios/whisper/`.
- Assembling holds `.native-frameworks.lock` in this directory, so two native framework targets under `make -j` wait for each other instead of writing the payload at once.
