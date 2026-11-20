/* Fake whisper glue for the host tests of sc_whisper_core.c: argv tokens select what a session does. */
#define _GNU_SOURCE
#include "sc_whisper_core.h"

#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define BOUND_SEC 20

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int interrupted;
static int resets, runs;
static int last_argc;
static char last_argv[16][64];

void sc_glue_reset(void) {
    pthread_mutex_lock(&mu);
    interrupted = 0;
    resets++;
    pthread_mutex_unlock(&mu);
}

void sc_glue_interrupt(void) {
    pthread_mutex_lock(&mu);
    interrupted = 1;
    pthread_cond_broadcast(&cv);
    pthread_mutex_unlock(&mu);
}

void fake_counters(int *out) {
    pthread_mutex_lock(&mu);
    out[0] = resets;
    out[1] = runs;
    out[2] = last_argc;
    pthread_mutex_unlock(&mu);
}

void fake_last_argv(int index, char *buf, int cap) {
    pthread_mutex_lock(&mu);
    snprintf(buf, (size_t)cap, "%s", index < 16 ? last_argv[index] : "");
    pthread_mutex_unlock(&mu);
}

static void wait_for_interrupt(void) {
    struct timespec limit;
    clock_gettime(CLOCK_REALTIME, &limit);
    limit.tv_sec += BOUND_SEC;
    pthread_mutex_lock(&mu);
    int rc = 0;
    while (!interrupted && rc == 0) rc = pthread_cond_timedwait(&cv, &mu, &limit);
    pthread_mutex_unlock(&mu);
}

int sc_glue_run(int tool, int argc, char **argv) {
    pthread_mutex_lock(&mu);
    runs++;
    last_argc = argc;
    for (int i = 0; i < argc && i < 16; i++) snprintf(last_argv[i], sizeof last_argv[i], "%s", argv[i]);
    pthread_mutex_unlock(&mu);
    int status = 0;
    for (int i = 1; i < argc; i++) {
        const char *t = argv[i];
        if (strcmp(t, "echo") == 0) {
            fprintf(sc_out(), "tool=%d out\n", tool);
            fflush(sc_out());
            fputs("err line\n", sc_err());
        } else if (strcmp(t, "block") == 0) {
            wait_for_interrupt();
        } else if (strcmp(t, "exit-mapped") == 0) {
            exit(7);
        } else if (strcmp(t, "abort-mapped") == 0) {
            abort();
        } else if (strncmp(t, "exit:", 5) == 0) {
            sc_tool_exit(atoi(t + 5));
        } else if (strncmp(t, "ret:", 4) == 0) {
            status = atoi(t + 4);
        }
    }
    return status;
}
