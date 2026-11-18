/* Portable session core of the sc_ffmpeg_* ABI: queue, fd ownership, argv policy, exit path. */
#define _GNU_SOURCE
#include "sc_ffmpeg_core.h"

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

#define QUEUE_CAP 16
#define MAX_ARGC 4096
#define STACK_BYTES (4u << 20)
#define CANCELLED_CODE 255

enum { QUEUED, RUNNING, DONE };

struct copy {
    int fd;
    dev_t dev;
    ino_t ino;
};

struct session {
    struct session *next;
    struct session *qnext;
    uint64_t id;
    int state;
    int claimed;
    int interrupted;
    int failed;
    int code;
    int tool;
    int argc;
    char **argv;
    int orig[3];
    struct copy *copies;
    int ncopies;
    const char *reject;
};

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wake = PTHREAD_COND_INITIALIZER;
static struct session *sessions;
static struct session *queue_head;
static struct session *queue_tail;
static struct session *current;
static int queued;
static uint64_t counter;
static int worker_started;

static pthread_mutex_t discard_lock = PTHREAD_MUTEX_INITIALIZER;
static FILE *discard;
static FILE *fallback;
static _Atomic(FILE *) out_file;
static _Atomic(FILE *) err_file;
static atomic_int stopped;
static _Thread_local sigjmp_buf *owner_jump;

static int dup_high(int fd) { return fcntl(fd, F_DUPFD_CLOEXEC, 3); }

static int ensure_discard(void) {
    int rc = 0;
    pthread_mutex_lock(&discard_lock);
    if (!discard) {
        signal(SIGPIPE, SIG_IGN);
        int low = open("/dev/null", O_WRONLY | O_CLOEXEC);
        if (low < 0) {
            rc = -errno;
        } else {
            int high = dup_high(low);
            rc = high < 0 ? -errno : 0;
            close(low);
            if (high >= 0 && !(discard = fdopen(high, "w"))) {
                rc = -errno;
                close(high);
            }
        }
    }
    pthread_mutex_unlock(&discard_lock);
    return rc;
}

static FILE *session_file(_Atomic(FILE *) *slot) {
    FILE *f = atomic_load(slot);
    if (f && !atomic_load(&stopped)) return f;
    ensure_discard();
    pthread_mutex_lock(&discard_lock);
    FILE *result = discard;
    if (!result) {
        if (!fallback) fallback = fmemopen(NULL, 1, "w+");
        result = fallback;
    }
    pthread_mutex_unlock(&discard_lock);
    return result;
}

FILE *sc_out(void) { return session_file(&out_file); }
FILE *sc_err(void) { return session_file(&err_file); }

SC_EXPORT int sc_ffmpeg_abi_version(void) { return 1; }

static void close_originals(struct session *s) {
    for (int i = 0; i < 3; i++) {
        if (s->orig[i] >= 0) {
            close(s->orig[i]);
            s->orig[i] = -1;
        }
    }
}

static void release_copies(struct session *s) {
    for (int i = 0; i < s->ncopies; i++) {
        struct stat st;
        if (s->copies[i].fd >= 0 && fstat(s->copies[i].fd, &st) == 0 &&
            st.st_dev == s->copies[i].dev && st.st_ino == s->copies[i].ino)
            close(s->copies[i].fd);
    }
    free(s->copies);
    s->copies = NULL;
    s->ncopies = 0;
}

static void free_argv(struct session *s) {
    if (s->argv) {
        for (int i = 0; i < s->argc; i++) free(s->argv[i]);
        free(s->argv);
    }
    s->argv = NULL;
    s->argc = 0;
}

static void free_session(struct session *s) {
    close_originals(s);
    release_copies(s);
    free_argv(s);
    free(s);
}

static struct session *find(int64_t id) {
    for (struct session *s = sessions; s; s = s->next)
        if ((int64_t)s->id == id) return s;
    return NULL;
}

static void unlink_session(struct session *s) {
    for (struct session **p = &sessions; *p; p = &(*p)->next) {
        if (*p == s) {
            *p = s->next;
            return;
        }
    }
}

static void unlink_queued(struct session *s) {
    struct session *prev = NULL;
    for (struct session *q = queue_head; q; prev = q, q = q->qnext) {
        if (q != s) continue;
        if (prev) prev->qnext = q->qnext;
        else queue_head = q->qnext;
        if (queue_tail == q) queue_tail = prev;
        queued--;
        return;
    }
}

static int all_digits(const char *p) {
    if (!*p) return 0;
    for (; *p; p++)
        if (*p < '0' || *p > '9') return 0;
    return 1;
}

static int mentions_forbidden(const char *arg) {
    static const char *const forbidden[] = {
        "pipe:", "fd:", "file:", "/dev/", "/proc/", "dev/fd", "dev/stdin", "dev/stdout",
        "dev/stderr", "proc/self",
    };
    if (strcmp(arg, "-stdin") == 0) return 1;
    char *plain = malloc(strlen(arg) + 1);
    if (!plain) return 1;
    char *w = plain;
    for (const char *r = arg; *r; r++)
        if (*r != '\\' && *r != '\'' && *r != '"') *w++ = *r;
    *w = '\0';
    int found = 0;
    for (size_t i = 0; i < sizeof forbidden / sizeof *forbidden && !found; i++)
        found = strstr(plain, forbidden[i]) != NULL;
    free(plain);
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

static int rewrite_path(struct session *s, int index, int dash_stream) {
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
        if (mentions_forbidden(arg)) s->reject = "argument names a forbidden location";
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
        int after_input = strcmp(prev, "-i") == 0;
        int after_progress = strcmp(prev, "-progress") == 0;
        if (after_input || after_progress || i == s->argc - 1) {
            int dash_stream = after_input ? 0 : after_progress ? 1 : ffmpeg ? 1 : 0;
            int rc = rewrite_path(s, i, dash_stream);
            if (rc) return rc;
        } else if (strcmp(s->argv[i], "-") == 0) {
            s->reject = "- is only allowed after -i, after -progress or as the last argument";
        } else if (mentions_forbidden(s->argv[i])) {
            s->reject = "argument names a forbidden location";
        }
    }
    if (s->reject) release_copies(s);
    return 0;
}

static struct session *build_session(int argc, const char *const *argv, const int fds[3], int *err) {
    struct session *s = calloc(1, sizeof *s);
    if (!s) {
        *err = -ENOMEM;
        return NULL;
    }
    for (int i = 0; i < 3; i++) s->orig[i] = -1;
    for (int i = 0; i < 3; i++) {
        if (fds[i] < 0) continue;
        s->orig[i] = dup_high(fds[i]);
        if (s->orig[i] < 0) {
            *err = -errno;
            free_session(s);
            return NULL;
        }
    }
    s->tool = strcmp(argv[0], "ffmpeg") == 0 ? 0 : 1;
    s->argv = calloc((size_t)argc + 2, sizeof *s->argv);
    s->copies = calloc((size_t)argc + 2, sizeof *s->copies);
    if (!s->argv || !s->copies) {
        *err = -ENOMEM;
        free_session(s);
        return NULL;
    }
    for (int i = 0; i < argc; i++) {
        if (i == 1 && s->tool == 0) {
            s->argv[s->argc] = strdup("-nostdin");
            if (!s->argv[s->argc++]) goto nomem;
        }
        s->argv[s->argc] = strdup(argv[i]);
        if (!s->argv[s->argc++]) goto nomem;
    }
    if (argc == 1 && s->tool == 0) {
        s->argv[s->argc] = strdup("-nostdin");
        if (!s->argv[s->argc++]) goto nomem;
    }
    *err = apply_policy(s);
    if (*err) {
        free_session(s);
        return NULL;
    }
    return s;
nomem:
    *err = -ENOMEM;
    free_session(s);
    return NULL;
}

static void *worker_main(void *unused);

static int start_worker(void) {
    pthread_attr_t attr;
    pthread_t thread;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, STACK_BYTES);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    int rc = pthread_create(&thread, &attr, worker_main, NULL);
    pthread_attr_destroy(&attr);
    return rc;
}

SC_EXPORT int64_t sc_ffmpeg_start(int argc, const char *const *argv, int in_fd, int out_fd, int err_fd) {
    if (argc < 1 || argc > MAX_ARGC || !argv) return -EINVAL;
    for (int i = 0; i < argc; i++)
        if (!argv[i]) return -EINVAL;
    if (strcmp(argv[0], "ffmpeg") != 0 && strcmp(argv[0], "ffprobe") != 0) return -EINVAL;
    if (in_fd < -1 || out_fd < -1 || err_fd < -1) return -EBADF;
    int ready = ensure_discard();
    if (ready) return ready;
    const int fds[3] = {in_fd, out_fd, err_fd};
    int err = 0;
    struct session *s = build_session(argc, argv, fds, &err);
    if (!s) return err;
    pthread_mutex_lock(&lock);
    if (queued >= QUEUE_CAP) err = -EAGAIN;
    else if (!worker_started && (err = -start_worker()) == 0) worker_started = 1;
    if (err) {
        pthread_mutex_unlock(&lock);
        free_session(s);
        return err;
    }
    s->id = ++counter;
    s->next = sessions;
    sessions = s;
    if (queue_tail) queue_tail->qnext = s;
    else queue_head = s;
    queue_tail = s;
    queued++;
    pthread_cond_broadcast(&wake);
    pthread_mutex_unlock(&lock);
    return (int64_t)s->id;
}

SC_EXPORT int sc_ffmpeg_wait(int64_t id) {
    pthread_mutex_lock(&lock);
    struct session *s = find(id);
    if (!s || s->claimed) {
        pthread_mutex_unlock(&lock);
        return -ESRCH;
    }
    s->claimed = 1;
    while (s->state != DONE) pthread_cond_wait(&wake, &lock);
    int code = s->code;
    unlink_session(s);
    pthread_mutex_unlock(&lock);
    free_session(s);
    return code;
}

SC_EXPORT void sc_ffmpeg_cancel(int64_t id) {
    pthread_mutex_lock(&lock);
    struct session *s = find(id);
    if (s && s->state == QUEUED) {
        unlink_queued(s);
        s->code = CANCELLED_CODE;
        s->state = DONE;
        close_originals(s);
        release_copies(s);
        free_argv(s);
        pthread_cond_broadcast(&wake);
    } else if (s && s->state == RUNNING) {
        if (!s->interrupted && !s->reject) {
            s->interrupted = 1;
            atomic_store(&stopped, 1);
            sc_glue_interrupt();
        }
        close_originals(s);
    }
    pthread_mutex_unlock(&lock);
}

void sc_tool_exit(int code) {
    if (owner_jump) siglongjmp(*owner_jump, (code & 0xff) + 1);
    pthread_mutex_lock(&lock);
    if (current) {
        current->failed = 1;
        atomic_store(&stopped, 1);
    }
    pthread_mutex_unlock(&lock);
    sc_glue_interrupt();
    pthread_mutex_lock(&lock);
    if (current) close_originals(current);
    pthread_mutex_unlock(&lock);
    pthread_exit(NULL);
}

static FILE *open_stream(struct session *s, int stream) {
    if (s->orig[stream] < 0) return NULL;
    int fd = dup_high(s->orig[stream]);
    if (fd < 0) return NULL;
    FILE *f = fdopen(fd, "w");
    if (!f) {
        close(fd);
        return NULL;
    }
    if (stream == 2) setvbuf(f, NULL, _IONBF, 0);
    return f;
}

static int run_tool(struct session *s) {
    sigjmp_buf jump;
    volatile int code;
    owner_jump = &jump;
    int thrown = sigsetjmp(jump, 0);
    if (thrown == 0) code = sc_glue_run(s->tool, s->argc, s->argv);
    else code = thrown - 1;
    owner_jump = NULL;
    return code;
}

static void *worker_main(void *unused) {
    (void)unused;
    for (;;) {
        pthread_mutex_lock(&lock);
        while (!queue_head) pthread_cond_wait(&wake, &lock);
        struct session *s = queue_head;
        queue_head = s->qnext;
        if (!queue_head) queue_tail = NULL;
        queued--;
        s->state = RUNNING;
        current = s;
        FILE *out = open_stream(s, 1);
        FILE *err = open_stream(s, 2);
        atomic_store(&stopped, 0);
        atomic_store(&out_file, out);
        atomic_store(&err_file, err);
        if (!s->reject) sc_glue_reset();
        pthread_mutex_unlock(&lock);
        int code = 1;
        if (s->reject) {
            if (err) fprintf(err, "sc_ffmpeg: %s\n", s->reject);
        } else {
            code = run_tool(s);
        }
        atomic_store(&out_file, NULL);
        atomic_store(&err_file, NULL);
        if (out) fclose(out);
        if (err) fclose(err);
        pthread_mutex_lock(&lock);
        if (s->failed || code < 0 || code > 255) code = 1;
        s->code = code;
        release_copies(s);
        close_originals(s);
        free_argv(s);
        current = NULL;
        s->state = DONE;
        pthread_cond_broadcast(&wake);
        pthread_mutex_unlock(&lock);
    }
    return NULL;
}
