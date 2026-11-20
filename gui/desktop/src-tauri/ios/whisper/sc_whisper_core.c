/* Portable session core of the sc_whisper_* ABI: argv policy and the exported entry points over the shared session machinery. */
#define _GNU_SOURCE
#include "sc_whisper_core.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <setjmp.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define SC_LOG_NAME "sc_whisper"
#define SC_STACK_BYTES (8u << 20)
#define SC_CANCEL_FORCES_255 1
#include "../native/sc_session_core.inc"

#define CLI_NAME "whisper-cli"

static int sc_accepts_argv0(const char *argv0) { return strcmp(argv0, CLI_NAME) == 0; }

// 1 for a flag with no value, 2 for a flag with one value, 0 for anything else.
static int flag_arity(const char *arg) {
    static const char *const bare[] = {"-ojf", "-np"};
    static const char *const valued[] = {"-m", "-f", "-of", "-l", "-t", "--prompt"};
    for (size_t i = 0; i < sizeof bare / sizeof *bare; i++)
        if (strcmp(arg, bare[i]) == 0) return 1;
    for (size_t i = 0; i < sizeof valued / sizeof *valued; i++)
        if (strcmp(arg, valued[i]) == 0) return 2;
    return 0;
}

// -m, -f and -of name files: "-" would make the tool read stdin or write the process stdout, "@x" is a response file.
static int names_a_file(const char *flag) {
    return strcmp(flag, "-m") == 0 || strcmp(flag, "-f") == 0 || strcmp(flag, "-of") == 0;
}

static void apply_policy(struct session *s) {
    for (int i = 1; i < s->argc && !s->reject;) {
        const char *arg = s->argv[i];
        int arity = flag_arity(arg);
        if (arity == 0) {
            s->reject = "argument is not one of the supported whisper-cli flags";
        } else if (arity == 2 && i + 1 >= s->argc) {
            s->reject = "flag is missing its value";
        } else if (arity == 2 && names_a_file(arg) &&
                   (s->argv[i + 1][0] == '\0' || strcmp(s->argv[i + 1], "-") == 0 || s->argv[i + 1][0] == '@')) {
            s->reject = "file arguments must be paths";
        }
        i += arity == 2 ? 2 : 1;
    }
}

static int sc_build_argv(struct session *s, int argc, const char *const *argv) {
    s->tool = 0;
    for (int i = 0; i < argc; i++) {
        s->argv[s->argc] = strdup(argv[i]);
        if (!s->argv[s->argc++]) return -ENOMEM;
    }
    apply_policy(s);
    return 0;
}

SC_EXPORT int sc_whisper_abi_version(void) { return 1; }

SC_EXPORT int64_t sc_whisper_start(int argc, const char *const *argv, int in_fd, int out_fd, int err_fd) {
    return sc_session_start(argc, argv, in_fd, out_fd, err_fd);
}

SC_EXPORT int sc_whisper_wait(int64_t id) { return sc_session_wait(id); }

SC_EXPORT void sc_whisper_cancel(int64_t id) { sc_session_cancel(id); }
