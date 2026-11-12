/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

// Minimal audio decoding API on top of libavcodec, compiled to WebAssembly (see build.sh).
// It is the software fallback of the WRTS audio pipeline when WebCodecs is unavailable:
// one compressed frame in, planar 32-bit float PCM out.

#include <stdint.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/log.h>
#include <libavutil/mem.h>

#define EXPORT __attribute__((used, visibility("default")))

// Codec identifiers shared with the JavaScript side
enum { CODEC_AAC = 0, CODEC_MP3 = 1 };

typedef struct Decoder {
    AVCodecContext *context;
    AVPacket *packet;
    AVFrame *frame;
    uint8_t *input; // compressed frame written by JavaScript, with the padding libavcodec requires
    int input_capacity;
    float *output; // planar PCM, plane `c` starts at output + c * plane_capacity
    int plane_capacity; // frames per plane
    int plane_count; // planes allocated
    int frames; // frames decoded by the last decoder_decode call
    int channels;
    int rate;
} Decoder;

EXPORT void *decoder_malloc(int size) {
    return av_malloc(size);
}

EXPORT void decoder_free(void *ptr) {
    av_free(ptr);
}

EXPORT void decoder_close(Decoder *decoder) {
    if (!decoder) {
        return;
    }
    avcodec_free_context(&decoder->context);
    av_packet_free(&decoder->packet);
    av_frame_free(&decoder->frame);
    av_free(decoder->input);
    av_free(decoder->output);
    av_free(decoder);
}

/**
 * Open a decoder, `extradata` is the codec configuration (AudioSpecificConfig for AAC), it can be NULL.
 * `rate` and `channels` are hints, the decoded values are given by decoder_rate and decoder_channels.
 * Returns NULL on failure.
 */
EXPORT Decoder *decoder_open(int codec, int rate, int channels, const uint8_t *extradata, int extradata_size) {
    av_log_set_level(AV_LOG_QUIET);
    const AVCodec *avcodec = avcodec_find_decoder(codec == CODEC_MP3 ? AV_CODEC_ID_MP3 : AV_CODEC_ID_AAC);
    if (!avcodec) {
        return NULL;
    }
    Decoder *decoder = av_mallocz(sizeof(Decoder));
    if (!decoder) {
        return NULL;
    }
    decoder->context = avcodec_alloc_context3(avcodec);
    decoder->packet = av_packet_alloc();
    decoder->frame = av_frame_alloc();
    if (!decoder->context || !decoder->packet || !decoder->frame) {
        decoder_close(decoder);
        return NULL;
    }
    if (rate > 0) {
        decoder->context->sample_rate = rate;
    }
    if (channels > 0) {
        av_channel_layout_default(&decoder->context->ch_layout, channels);
    }
    if (extradata && extradata_size > 0) {
        decoder->context->extradata = av_mallocz(extradata_size + AV_INPUT_BUFFER_PADDING_SIZE);
        if (!decoder->context->extradata) {
            decoder_close(decoder);
            return NULL;
        }
        memcpy(decoder->context->extradata, extradata, extradata_size);
        decoder->context->extradata_size = extradata_size;
    }
    decoder->context->thread_count = 1;
    if (avcodec_open2(decoder->context, avcodec, NULL) < 0) {
        decoder_close(decoder);
        return NULL;
    }
    return decoder;
}

/**
 * Returns a buffer of at least `size` bytes where to write the next compressed frame, NULL on failure
 */
EXPORT uint8_t *decoder_input(Decoder *decoder, int size) {
    if (size < 0) {
        return NULL;
    }
    if (size + AV_INPUT_BUFFER_PADDING_SIZE > decoder->input_capacity) {
        int capacity = (size + AV_INPUT_BUFFER_PADDING_SIZE) * 2;
        uint8_t *input = av_realloc(decoder->input, capacity);
        if (!input) {
            return NULL;
        }
        decoder->input = input;
        decoder->input_capacity = capacity;
    }
    return decoder->input;
}

// Grow the planar output to hold `frames` frames on `channels` planes, the frames already decoded are kept
static int reserve_output(Decoder *decoder, int frames, int channels) {
    if (frames <= decoder->plane_capacity && channels <= decoder->plane_count) {
        return 0;
    }
    int plane_capacity = decoder->plane_capacity > 4096 ? decoder->plane_capacity : 4096;
    while (plane_capacity < frames) {
        plane_capacity *= 2;
    }
    int plane_count = channels > decoder->plane_count ? channels : decoder->plane_count;
    float *output = av_malloc((size_t)plane_capacity * plane_count * sizeof(float));
    if (!output) {
        return AVERROR(ENOMEM);
    }
    for (int c = 0; c < decoder->plane_count && decoder->frames; ++c) {
        memcpy(output + (size_t)c * plane_capacity, decoder->output + (size_t)c * decoder->plane_capacity,
               decoder->frames * sizeof(float));
    }
    av_free(decoder->output);
    decoder->output = output;
    decoder->plane_capacity = plane_capacity;
    decoder->plane_count = plane_count;
    return 0;
}

// Append the decoded frame to the planar float output
static int write_output(Decoder *decoder) {
    const AVFrame *frame = decoder->frame;
    const int channels = frame->ch_layout.nb_channels;
    const int count = frame->nb_samples;
    if (channels <= 0 || count <= 0) {
        return 0;
    }
    if (decoder->frames && (channels != decoder->channels || frame->sample_rate != decoder->rate)) {
        // The format changed inside the same packet, keep the new format only
        decoder->frames = 0;
    }
    int ret = reserve_output(decoder, decoder->frames + count, channels);
    if (ret < 0) {
        return ret;
    }
    decoder->channels = channels;
    decoder->rate = frame->sample_rate;
    const int planar = av_sample_fmt_is_planar(frame->format);
    for (int c = 0; c < channels; ++c) {
        float *out = decoder->output + (size_t)c * decoder->plane_capacity + decoder->frames;
        const uint8_t *in = planar ? frame->extended_data[c] : frame->extended_data[0];
        const int step = planar ? 1 : channels;
        const int first = planar ? 0 : c;
        switch (av_get_packed_sample_fmt(frame->format)) {
        case AV_SAMPLE_FMT_FLT: {
            const float *samples = (const float *)in;
            for (int i = 0; i < count; ++i) {
                out[i] = samples[first + i * step];
            }
            break;
        }
        case AV_SAMPLE_FMT_DBL: {
            const double *samples = (const double *)in;
            for (int i = 0; i < count; ++i) {
                out[i] = (float)samples[first + i * step];
            }
            break;
        }
        case AV_SAMPLE_FMT_S16: {
            const int16_t *samples = (const int16_t *)in;
            for (int i = 0; i < count; ++i) {
                out[i] = samples[first + i * step] / 32768.f;
            }
            break;
        }
        case AV_SAMPLE_FMT_S32: {
            const int32_t *samples = (const int32_t *)in;
            for (int i = 0; i < count; ++i) {
                out[i] = samples[first + i * step] / 2147483648.f;
            }
            break;
        }
        case AV_SAMPLE_FMT_U8: {
            for (int i = 0; i < count; ++i) {
                out[i] = (in[first + i * step] - 128) / 128.f;
            }
            break;
        }
        default:
            return AVERROR(ENOSYS);
        }
    }
    decoder->frames += count;
    return 0;
}

/**
 * Decode the `size` bytes written in the decoder_input buffer.
 * Returns the number of frames decoded (0 when the decoder needs more data), or a negative AVERROR code.
 */
EXPORT int decoder_decode(Decoder *decoder, int size) {
    decoder->frames = 0;
    if (size < 0 || size + AV_INPUT_BUFFER_PADDING_SIZE > decoder->input_capacity) {
        return AVERROR(EINVAL);
    }
    memset(decoder->input + size, 0, AV_INPUT_BUFFER_PADDING_SIZE);
    decoder->packet->data = decoder->input;
    decoder->packet->size = size;
    int ret = avcodec_send_packet(decoder->context, decoder->packet);
    if (ret < 0 && ret != AVERROR(EAGAIN)) {
        return ret;
    }
    for (;;) {
        ret = avcodec_receive_frame(decoder->context, decoder->frame);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
            break;
        }
        if (ret < 0) {
            return ret;
        }
        ret = write_output(decoder);
        av_frame_unref(decoder->frame);
        if (ret < 0) {
            return ret;
        }
    }
    return decoder->frames;
}

/**
 * Returns the PCM plane of `channel` decoded by the last decoder_decode call
 */
EXPORT float *decoder_output(Decoder *decoder, int channel) {
    if (channel < 0 || channel >= decoder->plane_count) {
        return NULL;
    }
    return decoder->output + (size_t)channel * decoder->plane_capacity;
}

EXPORT int decoder_channels(Decoder *decoder) {
    return decoder->channels;
}

EXPORT int decoder_rate(Decoder *decoder) {
    return decoder->rate;
}

/**
 * Forget the decoding state, to call on a discontinuity of the stream
 */
EXPORT void decoder_reset(Decoder *decoder) {
    avcodec_flush_buffers(decoder->context);
}
