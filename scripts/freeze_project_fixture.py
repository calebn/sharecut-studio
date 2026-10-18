#!/usr/bin/env python3
"""Capture saved project/history bytes from a build before tester delivery."""

import sys

from project_compat import main

if __name__ == "__main__":
    raise SystemExit(main(["freeze", *sys.argv[1:]]))
