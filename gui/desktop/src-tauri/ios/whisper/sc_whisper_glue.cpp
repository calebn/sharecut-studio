/* whisper side of the sc_whisper_* ABI: runs the wrapped cli, routes whisper and ggml logs to the session, holds the cancel latch. */
#include "sc_whisper_core.h"

#include <atomic>
#include <exception>

#include "ggml.h"
#include "whisper.h"

int sc_whisper_cli_main(int argc, char **argv);

static std::atomic<bool> interrupted{false};

bool sc_whisper_aborted(void) { return interrupted.load(std::memory_order_relaxed); }

static void session_log(enum ggml_log_level, const char *text, void *) { fputs(text, sc_err()); }

extern "C" int sc_glue_run(int, int argc, char **argv) {
    try {
        return sc_whisper_cli_main(argc, argv);
    } catch (const std::exception &e) {
        fprintf(sc_err(), "sc_whisper: %s\n", e.what());
    } catch (...) {
        fprintf(sc_err(), "sc_whisper: unknown exception\n");
    }
    return 1;
}

extern "C" void sc_glue_reset(void) {
    interrupted.store(false, std::memory_order_relaxed);
    whisper_log_set(session_log, nullptr);
}

extern "C" void sc_glue_interrupt(void) { interrupted.store(true, std::memory_order_relaxed); }
