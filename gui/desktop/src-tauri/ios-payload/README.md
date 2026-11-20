This directory holds the generated iOS payload (`Python.xcframework`, `FFmpeg.xcframework`, `app_packages` and the manifest).
`scripts/ios/build_payload.py` writes the Python parts and `scripts/ios/ffmpeg_framework.py assemble` writes `FFmpeg.xcframework` (`make ios-ffmpeg-device`, `make ios-ffmpeg-sim`); everything here except this file is gitignored.
`gui/desktop/src-tauri/ios/project.yml` points at it, so the directory name has to stay in the tree.
