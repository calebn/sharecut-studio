/* Portable session machinery shared by the in-process tool shims: queue, fd ownership, exit path.
   The includer defines SC_LOG_NAME (and optionally SC_STACK_BYTES, SC_CANCEL_FORCES_255), includes its
   own core header first, includes this file, then defines sc_accepts_argv0 and
   sc_build_argv and exports sc_session_start, sc_session_wait and sc_session_cancel under its ABI names. */
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

#define QUEUE_CAP 16
#define MAX_ARGC 4096
#ifndef SC_STACK_BYTES
#define SC_STACK_BYTES (4u << 20)
#endif
#ifndef SC_CANCEL_FORCES_255
#define SC_CANCEL_FORCES_255 0
#endif
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
static pthread_t worker_thread;

static pthread_mutex_t discard_lock = PTHREAD_MUTEX_INITIALIZER;
static FILE *discard;
static FILE *fallback;
static FILE *slot_file[3];
static int slot_fd[3] = {-1, -1, -1};
static int null_fd = -1;
static _Atomic(FILE *) out_file;
static _Atomic(FILE *) err_file;
static atomic_int stopped;
static _Thread_local sigjmp_buf *owner_jump;

static int dup_high(int fd) { return fcntl(fd, F_DUPFD_CLOEXEC, 3); }

static FILE *open_null_file(int base, int stream) {
    int high = stream == 0 ? base : dup_high(base);
    if (high < 0) return NULL;
    FILE *f = fdopen(high, "w");
    if (!f) {
        if (stream != 0) close(high);
        return NULL;
    }
    if (stream == 2) setvbuf(f, NULL, _IONBF, 0);
    if (stream >= 1) slot_fd[stream] = high;
    else null_fd = high;
    return f;
}

static int ensure_discard(void) {
    int rc = 0;
    pthread_mutex_lock(&discard_lock);
    if (!discard) {
        signal(SIGPIPE, SIG_IGN);
        int base = open("/dev/null", O_WRONLY | O_CLOEXEC);
        if (base >= 0 && base < 3) {
            int high = dup_high(base);
            close(base);
            base = high;
        }
        if (base < 0) {
            rc = -errno;
        } else {
            FILE *made = open_null_file(base, 0);
            FILE *out = made ? open_null_file(base, 1) : NULL;
            FILE *err = out ? open_null_file(base, 2) : NULL;
            if (err) {
                slot_file[1] = out;
                slot_file[2] = err;
                discard = made;
            } else {
                rc = errno ? -errno : -EMFILE;
                if (made) fclose(made);
                else close(base);
                if (out) fclose(out);
                null_fd = -1;
                slot_fd[1] = slot_fd[2] = -1;
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

static int sc_accepts_argv0(const char *argv0);
static int sc_build_argv(struct session *s, int argc, const char *const *argv);

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
    s->argv = calloc((size_t)argc + 2, sizeof *s->argv);
    s->copies = calloc((size_t)argc + 2, sizeof *s->copies);
    if (!s->argv || !s->copies) {
        *err = -ENOMEM;
        free_session(s);
        return NULL;
    }
    *err = sc_build_argv(s, argc, argv);
    if (*err) {
        free_session(s);
        return NULL;
    }
    return s;
}

static void *worker_main(void *unused);

// Process-wide SIGUSR2, no SA_RESTART: a kick fails a blocked read(2) or write(2) with EINTR.
static void kick_handler(int signo) {
    (void)signo;
}

static int start_worker(void) {
    pthread_attr_t attr;
    pthread_t thread;
    struct sigaction action;
    memset(&action, 0, sizeof action);
    action.sa_handler = kick_handler;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGUSR2, &action, NULL) != 0) return errno;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, SC_STACK_BYTES);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    int rc = pthread_create(&thread, &attr, worker_main, NULL);
    pthread_attr_destroy(&attr);
    if (rc == 0) worker_thread = thread;
    return rc;
}

static int64_t sc_session_start(int argc, const char *const *argv, int in_fd, int out_fd, int err_fd) {
    if (argc < 1 || argc > MAX_ARGC || !argv) return -EINVAL;
    for (int i = 0; i < argc; i++)
        if (!argv[i]) return -EINVAL;
    if (!sc_accepts_argv0(argv[0])) return -EINVAL;
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

static int sc_session_wait(int64_t id) {
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

static void sc_session_cancel(int64_t id) {
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
        if (!s->reject) pthread_kill(worker_thread, SIGUSR2);
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
    FILE *f = slot_file[stream];
    fflush(f);
    if (dup2(s->orig[stream], slot_fd[stream]) < 0) return NULL;
    fcntl(slot_fd[stream], F_SETFD, FD_CLOEXEC);
    return f;
}

static void close_stream(FILE *f, int stream) {
    if (!f) return;
    fflush(f);
    dup2(null_fd, slot_fd[stream]);
    fcntl(slot_fd[stream], F_SETFD, FD_CLOEXEC);
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
    sigset_t kick;
    sigemptyset(&kick);
    sigaddset(&kick, SIGUSR2);
    pthread_sigmask(SIG_UNBLOCK, &kick, NULL);
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
            if (err) fprintf(err, SC_LOG_NAME ": %s\n", s->reject);
        } else {
            code = run_tool(s);
        }
        atomic_store(&out_file, NULL);
        atomic_store(&err_file, NULL);
        close_stream(out, 1);
        close_stream(err, 2);
        pthread_mutex_lock(&lock);
        // exit code: 1 when sc_tool_exit ended the tool on a thread other than the worker or the tool returned outside
        // 0..255 (even if cancelled); else 255 when cancelled while running and SC_CANCEL_FORCES_255 is set; else the tool's code.
        if (s->failed || code < 0 || code > 255) code = 1;
        else if (SC_CANCEL_FORCES_255 && s->interrupted) code = CANCELLED_CODE;
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

/* Path-name checks shared by the argv policies of both cores. */
// Strip escapes and quotes, lower-case ASCII, collapse runs of '/' and "/./" segments.
static char *normalise_arg(const char *arg) {
    size_t n = strlen(arg);
    char *plain = malloc(n + 1);
    if (!plain) return NULL;
    char *w = plain;
    for (const char *r = arg; *r; r++)
        if (*r != '\\' && *r != '\'' && *r != '"') *w++ = (char)tolower((unsigned char)*r);
    *w = '\0';
    char *out = malloc(n + 1);
    if (!out) {
        free(plain);
        return NULL;
    }
    w = out;
    for (const char *r = plain; *r; r++) {
        if (*r == '/' && w > out && w[-1] == '/') continue;
        if (*r == '.' && r[1] == '/' && w > out && w[-1] == '/') {
            r++;
            continue;
        }
        *w++ = *r;
    }
    *w = '\0';
    free(plain);
    return out;
}

// "dev/" or "proc/" at the token start (after an optional "./" and one optional '/') or after
// = : , ; [ ] ( ) | or space, with one optional '/' between the delimiter and the directory
// (a '+' counts only before that '/').
static int has_device_dir(const char *text) {
    const char *head = text + (strncmp(text, "./", 2) == 0 ? 2 : 0);
    head += *head == '/';
    static const char *const dirs[] = {"dev/", "proc/"};
    for (size_t i = 0; i < sizeof dirs / sizeof *dirs; i++) {
        size_t len = strlen(dirs[i]);
        if (strncmp(head, dirs[i], len) == 0) return 1;
        for (const char *p = strstr(text, dirs[i]); p; p = strstr(p + 1, dirs[i]))
            if (p > text && (strchr("=:,;[]()| ", p[-1]) ||
                             (p[-1] == '/' && p - 1 > text && strchr("=:+,;[]()| ", p[-2]))))
                return 1;
    }
    return 0;
}

static int has_dotdot_component(const char *text) {
    for (const char *p = text; (p = strstr(p, "..")) != NULL; p++)
        if ((p == text || p[-1] == '/') && (p[2] == '/' || p[2] == '\0')) return 1;
    return 0;
}
