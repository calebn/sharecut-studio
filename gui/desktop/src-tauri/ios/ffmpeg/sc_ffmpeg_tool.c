/* Wrapper TU of fftools/ffmpeg.c (built with -Dmain=sc_ffmpeg_main): per-session reset and the interrupt latch. */
#define term_init sc_term_init_unused
#include "fftools/ffmpeg.c"
#undef term_init

void term_init(void);
void sc_ffmpeg_opt_reset(void);
void sc_ffmpeg_tool_reset(void);
void sc_ffmpeg_tool_interrupt(void);

void term_init(void) {}

void sc_ffmpeg_tool_reset(void) {
    __atomic_store_n(&received_sigterm, 0, __ATOMIC_SEQ_CST);
    __atomic_store_n(&received_nb_signals, 0, __ATOMIC_SEQ_CST);
    atomic_store(&transcode_init_done, 0);
    atomic_store(&nb_output_dumped, 0);
    ffmpeg_exited = 0;
#if HAVE_TERMIOS_H
    restore_tty = 0;
#endif
    copy_ts_first_pts = AV_NOPTS_VALUE;
    vstats_file = NULL;
    progress_avio = NULL;

    input_files = NULL;
    output_files = NULL;
    filtergraphs = NULL;
    decoders = NULL;
    nb_input_files = 0;
    nb_output_files = 0;
    nb_filtergraphs = 0;
    nb_decoders = 0;

    vstats_filename = NULL;
    dts_delta_threshold = 10;
    dts_error_threshold = 3600 * 30;
    frame_drop_threshold = 0;
    do_benchmark = 0;
    do_benchmark_all = 0;
    do_hex_dump = 0;
    do_pkt_dump = 0;
    copy_ts = 0;
    start_at_zero = 0;
    copy_tb = -1;
    debug_ts = 0;
    exit_on_error = 0;
    abort_on_flags = 0;
    print_stats = -1;
    stdin_interaction = 1;
    max_error_rate = 2.0 / 3;
    filter_nbthreads = NULL;
    filter_complex_nbthreads = 0;
    filter_buffered_frames = 0;
    vstats_version = 2;
    print_graphs = 0;
    print_graphs_file = NULL;
    print_graphs_format = NULL;
    auto_conversion_filters = 1;
    stats_period = 500000;
    ignore_unknown_streams = 0;
    copy_unknown_streams = 0;
    recast_media = 0;
    filter_hw_device = NULL;
    sc_ffmpeg_opt_reset();
}

void sc_ffmpeg_tool_interrupt(void) {
    __atomic_store_n(&received_sigterm, SIGTERM, __ATOMIC_SEQ_CST);
    __atomic_store_n(&received_nb_signals, 2, __ATOMIC_SEQ_CST);
}
