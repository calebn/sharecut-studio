/* Forced include for FFmpeg, lame and opus: stdout, stderr and the printf family go to the session streams. */
#ifndef SC_FFTOOLS_STDIO_H
#define SC_FFTOOLS_STDIO_H

#ifndef __ASSEMBLER__

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "sc_ffmpeg_core.h"

static inline int sc_session_vprintf(const char *fmt, va_list ap) { return vfprintf(sc_out(), fmt, ap); }

static inline int sc_session_printf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static inline int sc_session_printf(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = vfprintf(sc_out(), fmt, ap);
    va_end(ap);
    return n;
}

static inline int sc_session_puts(const char *s) {
    FILE *f = sc_out();
    if (fputs(s, f) == EOF) return EOF;
    return fputc('\n', f) == EOF ? EOF : 1;
}

static inline int sc_session_putchar(int c) { return fputc(c, sc_out()); }

static inline void sc_session_perror(const char *s) {
    int saved = errno;
    if (s && *s) fprintf(sc_err(), "%s: %s\n", s, strerror(saved));
    else fprintf(sc_err(), "%s\n", strerror(saved));
}

static inline int sc_session_setvbuf(FILE *f, char *buf, int mode, size_t size) {
    if (f == sc_out() || f == sc_err()) return 0;
    return setvbuf(f, buf, mode, size);
}

#undef stdout
#undef stderr
#undef printf
#undef vprintf
#undef puts
#undef putchar
#undef perror
#undef setvbuf
#define stdout (sc_out())
#define stderr (sc_err())
#define printf(...) sc_session_printf(__VA_ARGS__)
#define vprintf(fmt, ap) sc_session_vprintf(fmt, ap)
#define puts(s) sc_session_puts(s)
#define putchar(c) sc_session_putchar(c)
#define perror(s) sc_session_perror(s)
#define setvbuf(f, buf, mode, size) sc_session_setvbuf(f, buf, mode, size)

#endif

#endif
