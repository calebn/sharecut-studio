/* FFmpeg side of the sc_ffmpeg_* ABI: runs the wrapped tools, resets their state, routes av_log to the session. */
#include "sc_ffmpeg_core.h"

#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>

#include "libavformat/avio.h"
#include "libavutil/log.h"

int sc_ffmpeg_main(int argc, char **argv);
int sc_ffprobe_main(int argc, char **argv);
void sc_ffmpeg_tool_reset(void);
void sc_ffmpeg_tool_interrupt(void);
void sc_ffprobe_tool_reset(void);

extern AVIOContext *progress_avio;
extern FILE *vstats_file;
extern int hide_banner;

static pthread_mutex_t log_lock = PTHREAD_MUTEX_INITIALIZER;
static int log_print_prefix = 1;

static void sc_log(void *ptr, int level, const char *fmt, va_list vl) {
    char line[1024];
    if (level >= 0) level &= 0xff;
    if (level > av_log_get_level()) return;
    pthread_mutex_lock(&log_lock);
    av_log_format_line2(ptr, level, fmt, vl, line, sizeof line, &log_print_prefix);
    fputs(line, sc_err());
    pthread_mutex_unlock(&log_lock);
}

int sc_glue_run(int tool, int argc, char **argv) {
    if (tool != 0) return sc_ffprobe_main(argc, argv);
    int code = sc_ffmpeg_main(argc, argv);
    avio_closep(&progress_avio);
    vstats_file = NULL;
    return code;
}

void sc_glue_reset(void) {
    sc_ffmpeg_tool_reset();
    sc_ffprobe_tool_reset();
    hide_banner = 0;
    pthread_mutex_lock(&log_lock);
    log_print_prefix = 1;
    pthread_mutex_unlock(&log_lock);
    av_log_set_level(AV_LOG_INFO);
    av_log_set_callback(sc_log);
}

void sc_glue_interrupt(void) { sc_ffmpeg_tool_interrupt(); }
