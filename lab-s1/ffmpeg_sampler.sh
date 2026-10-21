#!/bin/sh
# usage: ffmpeg_sampler.sh out.txt  (Ctrl-C when the batch finishes). Samples running ffmpeg processes every 0.2 s.
while true; do echo "$(date +%s) $(pgrep -x ffmpeg | wc -l | tr -d ' ')" >> "$1"; sleep 0.2; done
