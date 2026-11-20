/* Portable session core of the sc_ffmpeg_* ABI: argv policy and the exported entry points over the shared session machinery. */
#define _GNU_SOURCE
#include "sc_ffmpeg_core.h"

#define SC_LOG_NAME "sc_ffmpeg"
#include "../native/sc_session_core.inc"

static int all_digits(const char *p) {
    if (!*p) return 0;
    for (; *p; p++)
        if (*p < '0' || *p > '9') return 0;
    return 1;
}

// A protocol word matches at the token start or after one of = , ; [ ] ( ) | : + or / (not "./").
static int has_protocol_word(const char *text, const char *word) {
    for (const char *p = strstr(text, word); p; p = strstr(p + 1, word)) {
        if (p == text) return 1;
        if (p[-1] == '/' && !(p - 1 == text + 1 && text[0] == '.')) return 1;
        if (p[-1] != '/' && strchr("=,;[]()|:+", p[-1])) return 1;
    }
    return 0;
}

// metadata_value: the token follows -metadata[:spec], so only the text before the first '=' counts.
static int mentions_forbidden(const char *arg, int metadata_value) {
    static const char *const protocols[] = {"pipe:", "fd:", "file:"};
    static const char *const words[] = {
        "pattern_type", "movie=", "amovie=", "format_opts", "dev/std", "proc/self",
    };
    char *text = normalise_arg(arg);
    if (!text) return 1;
    char *eq = metadata_value ? strchr(text, '=') : NULL;
    if (eq) *eq = '\0';
    int found = has_dotdot_component(text) || has_device_dir(text);
    found = found || strcmp(text, "-stdin") == 0 || strncmp(text, "-stdin:", 7) == 0 ||
            (strncmp(text, "-/", 2) == 0 && strcmp(text, "-/filter_complex") != 0) ||
            strcmp(text, "-filter_script") == 0 || strncmp(text, "-filter_script:", 15) == 0 ||
            strncmp(text, "-filter_complex_script", 22) == 0;
    for (size_t i = 0; i < sizeof protocols / sizeof *protocols && !found; i++)
        found = has_protocol_word(text, protocols[i]);
    for (size_t i = 0; i < sizeof words / sizeof *words && !found; i++)
        found = strstr(text, words[i]) != NULL;
    free(text);
    return found;
}

static int add_copy(struct session *s, int stream, int index, const char *prefix) {
    struct stat st;
    int fd = dup_high(s->orig[stream]);
    if (fd < 0) return -errno;
    if (fstat(fd, &st) != 0) {
        int err = errno;
        close(fd);
        return -err;
    }
    char text[32];
    snprintf(text, sizeof text, "%s%d", prefix, fd);
    char *replacement = strdup(text);
    if (!replacement) {
        close(fd);
        return -ENOMEM;
    }
    s->copies[s->ncopies++] = (struct copy){fd, st.st_dev, st.st_ino};
    free(s->argv[index]);
    s->argv[index] = replacement;
    return 0;
}

static int rewrite_path(struct session *s, int index, int dash_stream, int metadata_value) {
    const char *arg = s->argv[index];
    int stream;
    const char *prefix;
    if (strcmp(arg, "-") == 0) {
        stream = dash_stream;
        prefix = stream == 0 ? "fd:" : "pipe:";
    } else if (strncmp(arg, "pipe:", 5) == 0 || strncmp(arg, "fd:", 3) == 0) {
        prefix = arg[0] == 'p' ? "pipe:" : "fd:";
        const char *digits = arg + strlen(prefix);
        if (!all_digits(digits)) {
            s->reject = "pipe: and fd: arguments must name fd 0, 1 or 2";
            return 0;
        }
        if (digits[1] != '\0' || digits[0] > '2') {
            s->reject = "fd numbers above 2 are not allowed";
            return 0;
        }
        stream = digits[0] - '0';
    } else {
        if (mentions_forbidden(arg, metadata_value))
            s->reject = "argument names a forbidden location";
        return 0;
    }
    if (s->orig[stream] < 0) {
        s->reject = "argument names a stream that was not provided";
        return 0;
    }
    return add_copy(s, stream, index, prefix);
}

static int apply_policy(struct session *s) {
    int ffmpeg = s->tool == 0;
    for (int i = 1; i < s->argc && !s->reject; i++) {
        const char *prev = s->argv[i - 1];
        int metadata_value = strcmp(prev, "-metadata") == 0 || strncmp(prev, "-metadata:", 10) == 0;
        int after_input = strcmp(prev, "-i") == 0;
        int after_progress = strcmp(prev, "-progress") == 0;
        if (after_input || after_progress || i == s->argc - 1) {
            int dash_stream = after_input ? 0 : after_progress ? 1 : ffmpeg ? 1 : 0;
            int rc = rewrite_path(s, i, dash_stream, metadata_value);
            if (rc) return rc;
        } else if (strcmp(s->argv[i], "-") == 0) {
            s->reject = "- is only allowed after -i, after -progress or as the last argument";
        } else if (mentions_forbidden(s->argv[i], metadata_value)) {
            s->reject = "argument names a forbidden location";
        }
    }
    if (s->reject) release_copies(s);
    return 0;
}

static int sc_accepts_argv0(const char *argv0) {
    return strcmp(argv0, "ffmpeg") == 0 || strcmp(argv0, "ffprobe") == 0;
}

static int sc_build_argv(struct session *s, int argc, const char *const *argv) {
    s->tool = strcmp(argv[0], "ffmpeg") == 0 ? 0 : 1;
    for (int i = 0; i < argc; i++) {
        if (i == 1 && s->tool == 0) {
            s->argv[s->argc] = strdup("-nostdin");
            if (!s->argv[s->argc++]) return -ENOMEM;
        }
        s->argv[s->argc] = strdup(argv[i]);
        if (!s->argv[s->argc++]) return -ENOMEM;
    }
    if (argc == 1 && s->tool == 0) {
        s->argv[s->argc] = strdup("-nostdin");
        if (!s->argv[s->argc++]) return -ENOMEM;
    }
    return apply_policy(s);
}

SC_EXPORT int sc_ffmpeg_abi_version(void) { return 1; }

SC_EXPORT int64_t sc_ffmpeg_start(int argc, const char *const *argv, int in_fd, int out_fd, int err_fd) {
    return sc_session_start(argc, argv, in_fd, out_fd, err_fd);
}

SC_EXPORT int sc_ffmpeg_wait(int64_t id) { return sc_session_wait(id); }

SC_EXPORT void sc_ffmpeg_cancel(int64_t id) { sc_session_cancel(id); }
