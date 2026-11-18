/* Wrapper TU of fftools/ffprobe.c (built with main, program_name, program_birth_year, show_help_default renamed). */
#include "fftools/ffprobe.c"

void sc_ffprobe_tool_reset(void);

void sc_ffprobe_tool_reset(void) {
    do_analyze_frames = 0;
    do_bitexact = 0;
    do_count_frames = 0;
    do_count_packets = 0;
    do_read_frames = 0;
    do_read_packets = 0;
    do_show_chapters = 0;
    do_show_error = 0;
    do_show_format = 0;
    do_show_frames = 0;
    do_show_packets = 0;
    do_show_programs = 0;
    do_show_stream_groups = 0;
    do_show_stream_group_components = 0;
    do_show_streams = 0;
    do_show_stream_disposition = 0;
    do_show_stream_group_disposition = 0;
    do_show_data = 0;
    do_show_program_version = 0;
    do_show_library_versions = 0;
    do_show_pixel_formats = 0;
    do_show_pixel_format_flags = 0;
    do_show_pixel_format_components = 0;
    do_show_log = 0;
    do_show_chapter_tags = 0;
    do_show_format_tags = 0;
    do_show_frame_tags = 0;
    do_show_program_tags = 0;
    do_show_stream_group_tags = 0;
    do_show_stream_tags = 0;
    do_show_packet_tags = 0;
    show_value_unit = 0;
    use_value_prefix = 0;
    use_byte_value_binary_prefix = 0;
    use_value_sexagesimal_format = 0;
    show_private_data = 1;
    show_optional_fields = SHOW_OPTIONAL_FIELDS_AUTO;
    find_stream_info = 1;
    iformat = NULL;

    av_freep(&audio_codec_name);
    av_freep(&data_codec_name);
    av_freep(&subtitle_codec_name);
    av_freep(&video_codec_name);
    av_freep(&output_format);
    av_freep(&stream_specifier);
    av_freep(&show_data_hash);
    av_freep(&data_dump_format);
    av_freep(&input_filename);
    av_freep(&output_filename);
    av_freep(&print_input_filename);
    av_freep(&read_intervals);
    read_intervals_nb = 0;

    nb_streams = 0;
    av_freep(&nb_streams_frames);
    av_freep(&nb_streams_packets);
    av_freep(&selected_streams);
    av_freep(&streams_with_closed_captions);
    av_freep(&streams_with_film_grain);

    for (int i = 0; i < log_buffer_size; i++) {
        av_freep(&log_buffer[i].context_name);
        av_freep(&log_buffer[i].parent_name);
        av_freep(&log_buffer[i].log_message);
    }
    av_freep(&log_buffer);
    log_buffer_size = 0;

    for (size_t i = 0; i < FF_ARRAY_ELEMS(selected_entries); i++) {
        av_dict_free(&selected_entries[i].entries_to_show);
        selected_entries[i].show_all_entries = 0;
    }
}
