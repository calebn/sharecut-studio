/* Portable session core of the sc_ffmpeg_* ABI; the FFmpeg side implements sc_glue_*. */
#ifndef SC_FFMPEG_CORE_H
#define SC_FFMPEG_CORE_H

#include <stdint.h>
#include <stdio.h>

#define SC_EXPORT __attribute__((visibility("default")))

SC_EXPORT int sc_ffmpeg_abi_version(void);
SC_EXPORT int64_t sc_ffmpeg_start(int argc, const char *const *argv, int in_fd, int out_fd, int err_fd);
SC_EXPORT int sc_ffmpeg_wait(int64_t session);
SC_EXPORT void sc_ffmpeg_cancel(int64_t session);

FILE *sc_out(void);
FILE *sc_err(void);
void sc_tool_exit(int code);

int sc_glue_run(int tool, int argc, char **argv);
void sc_glue_reset(void);
void sc_glue_interrupt(void);

#endif
