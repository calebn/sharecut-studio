/* Forced include for FFmpeg, lame and opus: exit() and abort() (134) unwind to the session owner. */
#ifndef SC_EXIT_MAP_H
#define SC_EXIT_MAP_H

#ifndef __ASSEMBLER__

#include <stdlib.h>

#include "sc_ffmpeg_core.h"

#undef exit
#define exit(code) sc_tool_exit(code)
#undef abort
#define abort() sc_tool_exit(134)

#endif

#endif
