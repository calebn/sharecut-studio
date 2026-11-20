/* Portable session core of the sc_whisper_* ABI; the whisper side implements sc_glue_*. */
#ifndef SC_WHISPER_CORE_H
#define SC_WHISPER_CORE_H

#include <stdint.h>
#include <stdio.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SC_EXPORT __attribute__((visibility("default")))

SC_EXPORT int sc_whisper_abi_version(void);
SC_EXPORT int64_t sc_whisper_start(int argc, const char *const *argv, int in_fd, int out_fd, int err_fd);
SC_EXPORT int sc_whisper_wait(int64_t session);
SC_EXPORT void sc_whisper_cancel(int64_t session);

FILE *sc_out(void);
FILE *sc_err(void);
void sc_tool_exit(int code) __attribute__((noreturn));

/* sc_out and sc_err are the session's streams; after cancel (or a non-owner sc_tool_exit) they
   become the discard stream. sc_tool_exit unwinds by siglongjmp on the worker thread and ends
   any other thread. */

/* sc_glue_run runs on the single worker thread. argv is NULL-terminated and owned by the core.
   The core clamps the return value: outside 0..255 becomes 1; a cancelled session returns 255. */
int sc_glue_run(int tool, int argc, char **argv);

/* sc_glue_reset runs with the core lock held: keep it quick. sc_glue_interrupt may run with or
   without the lock, from the cancel path or from a non-owner sc_tool_exit, concurrently with
   sc_glue_run: it must be async-safe. Neither may call back into the core (sc_whisper_*, sc_out,
   sc_err, sc_tool_exit). */
void sc_glue_reset(void);
void sc_glue_interrupt(void);

#ifdef __cplusplus
}
#endif

#endif
