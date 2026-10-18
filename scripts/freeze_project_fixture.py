#!/usr/bin/env python3
import sys

from project_compat import main

if __name__ == "__main__":
    raise SystemExit(main(["freeze", *sys.argv[1:]]))
