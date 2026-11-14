This directory holds the generated iOS payload (`Python.xcframework`, `app_packages` and the manifest).
`scripts/ios/build_payload.py` writes it, and everything here except this file is gitignored.
`gui/desktop/src-tauri/ios/project.yml` points at it, so the directory name has to stay in the tree.
