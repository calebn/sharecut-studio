/* Fake FFmpeg glue for the host tests of sc_ffmpeg_core.c: argv tokens select what a session does. */
#define _GNU_SOURCE
#include "sc_ffmpeg_core.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define BOUND_SEC 20

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int interrupted;
static long release_gen;
static int resets, runs, interrupts, reset_starts, big_writes;
static char order[8192];
static int reset_delay_ms, last_argc, reused_fd = -1;
static FILE *stray_out, *stray_err;

static int is_interrupted(void) {
    pthread_mutex_lock(&mu);
    int v = interrupted;
    pthread_mutex_unlock(&mu);
    return v;
}

void sc_glue_reset(void) {
    pthread_mutex_lock(&mu);
    reset_starts++;
    int delay = reset_delay_ms;
    pthread_mutex_unlock(&mu);
    if (delay) usleep((useconds_t)delay * 1000);
    pthread_mutex_lock(&mu);
    interrupted = 0;
    resets++;
    pthread_mutex_unlock(&mu);
}

void sc_glue_interrupt(void) {
    pthread_mutex_lock(&mu);
    interrupted = 1;
    interrupts++;
    pthread_cond_broadcast(&cv);
    pthread_mutex_unlock(&mu);
}

void fake_set_reset_delay_ms(int ms) {
    pthread_mutex_lock(&mu);
    reset_delay_ms = ms;
    pthread_mutex_unlock(&mu);
}

int fake_last_argc(void) {
    pthread_mutex_lock(&mu);
    int v = last_argc;
    pthread_mutex_unlock(&mu);
    return v;
}

int fake_reused_fd(void) {
    pthread_mutex_lock(&mu);
    int v = reused_fd;
    pthread_mutex_unlock(&mu);
    return v;
}

void fake_stray_write(void) {
    pthread_mutex_lock(&mu);
    FILE *o = stray_out, *e = stray_err;
    pthread_mutex_unlock(&mu);
    if (o) {
        fputs("stray-out\n", o);
        fflush(o);
    }
    if (e) fputs("stray-err\n", e);
    fputs("stray-fresh\n", sc_err());
}

void fake_release(void) {
    pthread_mutex_lock(&mu);
    release_gen++;
    pthread_cond_broadcast(&cv);
    pthread_mutex_unlock(&mu);
}

void fake_counters(int *out) {
    pthread_mutex_lock(&mu);
    out[0] = resets;
    out[1] = runs;
    out[2] = interrupts;
    pthread_mutex_unlock(&mu);
}

int fake_reset_starts(void) {
    pthread_mutex_lock(&mu);
    int v = reset_starts;
    pthread_mutex_unlock(&mu);
    return v;
}

int fake_big_writes(void) {
    pthread_mutex_lock(&mu);
    int v = big_writes;
    pthread_mutex_unlock(&mu);
    return v;
}

void fake_order(char *buf, int cap) {
    pthread_mutex_lock(&mu);
    snprintf(buf, (size_t)cap, "%s", order);
    pthread_mutex_unlock(&mu);
}

static int block_until(long gen, int stop_on_release) {
    struct timespec limit;
    clock_gettime(CLOCK_REALTIME, &limit);
    limit.tv_sec += BOUND_SEC;
    pthread_mutex_lock(&mu);
    int rc = 0;
    while (!interrupted && !(stop_on_release && release_gen > gen) && rc == 0)
        rc = pthread_cond_timedwait(&cv, &mu, &limit);
    int result = interrupted ? 255 : rc ? 99 : 0;
    pthread_mutex_unlock(&mu);
    return result;
}

static void *exit_thread(void *arg) {
    sc_tool_exit((int)(long)arg);
    return NULL;
}

static int fd_of(const char *arg) {
    const char *colon = strchr(arg, ':');
    return colon ? atoi(colon + 1) : -1;
}

static int read_all(int fd) {
    char buf[4096];
    long total = 0;
    for (int i = 0; i < BOUND_SEC * 20; i++) {
        if (is_interrupted()) return -1;
        struct pollfd p = {fd, POLLIN, 0};
        int rc = poll(&p, 1, 50);
        if (rc < 0 && errno != EINTR) break;
        if (rc <= 0) continue;
        ssize_t n = read(fd, buf, sizeof buf);
        if (n == 0) break;
        if (n > 0) total += n;
    }
    close(fd);
    return (int)total;
}

int sc_glue_run(int tool, int argc, char **argv) {
    long gen;
    pthread_mutex_lock(&mu);
    runs++;
    last_argc = argc;
    gen = release_gen;
    pthread_mutex_unlock(&mu);
    int status = 0;
    for (int i = 1; i < argc; i++) {
        const char *t = argv[i];
        if (strcmp(t, "echo") == 0) {
            fprintf(sc_out(), "tool=%d\n", tool);
            for (int k = 0; k < argc; k++) fprintf(sc_out(), "%s\n", argv[k]);
            fflush(sc_out());
        } else if (strcmp(t, "capture") == 0) {
            pthread_mutex_lock(&mu);
            stray_out = sc_out();
            stray_err = sc_err();
            pthread_mutex_unlock(&mu);
        } else if (strcmp(t, "started") == 0) {
            fputs("started\n", sc_err());
        } else if (strcmp(t, "progress") == 0) {
            for (int k = 0; k < 3; k++) fputs("progress=continue\n", sc_err());
        } else if (strcmp(t, "block") == 0 || strcmp(t, "hold") == 0) {
            int rc = block_until(gen, strcmp(t, "hold") == 0);
            if (rc) return rc;
        } else if (strcmp(t, "waitint") == 0) {
            block_until(gen, 0);
        } else if (strcmp(t, "bigerr") == 0 || strcmp(t, "bigout") == 0) {
            FILE *f = t[3] == 'e' ? sc_err() : sc_out();
            static char chunk[1 << 20];
            pthread_mutex_lock(&mu);
            big_writes++;
            pthread_mutex_unlock(&mu);
            fwrite(chunk, 1, sizeof chunk, f);
            fflush(f);
        } else if (strcmp(t, "stubborn") == 0) {
            pthread_mutex_lock(&mu);
            while (release_gen == gen) pthread_cond_wait(&cv, &mu);
            pthread_mutex_unlock(&mu);
        } else if (strcmp(t, "reuse") == 0) {
            int target = fd_of(argv[argc - 1]);
            int spare = open("/dev/null", O_RDONLY);
            dup2(spare, target);
            close(spare);
            pthread_mutex_lock(&mu);
            reused_fd = target;
            pthread_mutex_unlock(&mu);
        } else if (strncmp(t, "exit:", 5) == 0) {
            sc_tool_exit(atoi(t + 5));
        } else if (strncmp(t, "thread-exit:", 12) == 0) {
            pthread_t th;
            pthread_create(&th, NULL, exit_thread, (void *)(long)atoi(t + 12));
            pthread_join(th, NULL);
            block_until(gen, 0);
        } else if (strncmp(t, "ret:", 4) == 0) {
            status = atoi(t + 4);
        } else if (strncmp(t, "tag:", 4) == 0) {
            pthread_mutex_lock(&mu);
            size_t used = strlen(order);
            if (used + strlen(t) + 2 < sizeof order)
                snprintf(order + used, sizeof order - used, "%s,", t + 4);
            pthread_mutex_unlock(&mu);
        } else if (strcmp(t, "readin") == 0) {
            for (int k = 1; k + 1 < argc; k++) {
                if (strcmp(argv[k], "-i") != 0) continue;
                int n = read_all(fd_of(argv[k + 1]));
                if (n < 0) return 255;
                fprintf(sc_out(), "bytes=%d\n", n);
                fflush(sc_out());
            }
        } else if (strcmp(t, "writeout") == 0) {
            int fd = fd_of(argv[argc - 1]);
            if (fd >= 0 && write(fd, "payload", 7) == 7) close(fd);
        }
    }
    return status;
}
