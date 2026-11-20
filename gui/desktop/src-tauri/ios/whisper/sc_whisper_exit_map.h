/* Forced include for whisper.cpp, ggml and the cli wrapper: exit() and abort() (134) unwind to the session owner. */
#ifndef SC_WHISPER_EXIT_MAP_H
#define SC_WHISPER_EXIT_MAP_H

#ifndef __ASSEMBLER__

#include <stdlib.h>

#ifdef __cplusplus
#include <cstdlib>
#endif

#include "sc_whisper_core.h"

#ifdef __cplusplus
namespace std {
using ::sc_tool_exit;
}
#endif

#undef exit
#define exit(code) sc_tool_exit(code)
#undef abort
#define abort() sc_tool_exit(134)

#endif

#endif
