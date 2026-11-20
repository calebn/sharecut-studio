/* Forced include for the cli wrapper: stdout, stderr and printf go to the session streams. */
#ifndef SC_WHISPER_STDIO_H
#define SC_WHISPER_STDIO_H

#ifndef __ASSEMBLER__

#include <stdarg.h>
#include <stdio.h>

#include "sc_whisper_core.h"

#ifdef __cplusplus
#include <cstdio>
#endif

static inline int sc_session_printf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static inline int sc_session_printf(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = vfprintf(sc_out(), fmt, ap);
    va_end(ap);
    return n;
}

#undef stdout
#undef stderr
#undef printf
#define stdout (sc_out())
#define stderr (sc_err())
#define printf(...) sc_session_printf(__VA_ARGS__)

#endif

#endif
