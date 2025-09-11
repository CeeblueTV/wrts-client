/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */
import { BinaryWriter, BinaryReader, BitReader, log } from '@ceeblue/web-utils';
import * as Media from './Media';

export enum NAL {
    UNDEFINED = 0,
    SLICE_NIDR = 1,
    SLICE_A = 2,
    SLICE_B = 3,
    SLICE_C = 4,
    SLICE_IDR = 5,
    SEI = 6,
    SPS = 7,
    PPS = 8,
    AUD = 9,
    END_SEQ = 10,
    END_STREAM = 11,
    FILLER = 12
}

export type VideoConfig = {
    sps: Uint8Array;
    pps?: Uint8Array;
};

export function nalType(byte: number): NAL {
    return byte & 0x1f;
}

export function readVideoConfig(data: Uint8Array): VideoConfig {
    const reader = new BinaryReader(data);
    reader.next(5); // skip avcC version 1 + 3 bytes of profile, compatibility, level + 1 byte xFF
    // SPS and PPS
    let count = reader.read8() & 0x1f;
    const result: VideoConfig = { sps: data };
    while (reader.available() >= 2 && count--) {
        // loop over every NALU
        let size = reader.read16();
        if (size > reader.available()) {
            size = reader.available();
        }
        if (result.sps !== data) {
            result.pps = data.subarray(reader.position(), reader.position() + size);
            // ignore multiple PPS and  SPSE for now (WIP: save SPSE too and write it in WriteVideoConfig)
            break;
        }
        result.sps = data.subarray(reader.position(), reader.position() + size);
        reader.next(size);
        count = reader.read8(); // PPS now!
    }
    return result;
}

export function writeVideoConfig(writer: BinaryWriter, config: VideoConfig): BinaryWriter {
    // SPS + PPS
    writer.write8(0x01); // avcC version 1
    writer.write(config.sps.subarray(1, 4)); // profile, compatibility, level

    writer.write8(0xff); // 111111 + 2 bit NAL size - 1
    // sps
    writer.write8(0xe1); // 11 + number of SPS
    writer.write16(config.sps.length);
    writer.write(config.sps);

    // pps
    writer.write8(0x01); // number of PPS
    if (config.pps) {
        writer.write16(config.pps.length);
        writer.write(config.pps);
    } else {
        writer.write16(0);
    }
    return writer;
}

// 1024000.0/ [ 96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350 ] => t = 1/rate... 1024 samples/frame (in kHz)
const _audioRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 48000, 48000];
const _audioRateIndexes = new Map<number, number>();
for (const audioRate of _audioRates) {
    _audioRateIndexes.set(audioRate, _audioRateIndexes.size);
}

export function writeAudioConfig(type: number, rate: number, channels: number): Uint8Array {
    // http://wiki.multimedia.cx/index.php?title=MPEG-4_Audio
    // http://thompsonng.blogspot.fr/2010/03/aac-configuration.html
    // http://www.mpeg-audio.org/docs/w14751_(mpeg_AAC_TransportFormats).pdf
    const config = new Uint8Array(2);
    config[0] = type << 3; // 5 bits of object type (ADTS profile 2 first bits => MPEG-4 Audio Object Type minus 1)
    const rateIndex = _audioRateIndexes.get(rate) ?? 0;
    config[0] |= (rateIndex & 0x0f) >> 1;
    config[1] = (rateIndex & 0x01) << 7;
    config[1] |= (channels & 0x0f) << 3;
    return config;
}

export function readAudioConfig(data: Uint8Array): { rate: number; channels: number } | undefined {
    // http://wiki.multimedia.cx/index.php?title=MPEG-4_Audio
    // http://thompsonng.blogspot.fr/2010/03/aac-configuration.html
    // http://www.mpeg-audio.org/docs/w14751_(mpeg_AAC_TransportFormats).pdf

    if (data.byteLength < 2) {
        log('AAC configuration packet must have a minimum size of 2 bytes').warn();
        return;
    }

    const type = data[0] >> 3;
    if (!type) {
        log('AAC configuration packet invalid').warn();
        return;
    }
    return {
        rate: _audioRates[((data[0] & 3) << 1) | (data[1] >> 7)],
        channels: (data[1] >> 3) & 0x0f
    };
}

export function writeCodecString(codec: Media.Codec, config?: Uint8Array): string {
    switch (codec) {
        case Media.Codec.AAC: {
            let desc = 'mp4a.40';
            if (config && config.byteLength) {
                desc += '.' + (config[0] >> 3).toString();
            }
            return desc;
        }
        case Media.Codec.MP3:
            // mp4a.40.34 => MP3on4 Layer 3 : MP3 into MP4
            return 'mp4a.40.34';
        case Media.Codec.H264: {
            let desc = 'avc1';
            if (config) {
                desc += '.';
                const videoConfig = readVideoConfig(config);
                for (let j = 1; j < 4; ++j) {
                    const value = videoConfig.sps[j];
                    if (value < 16) {
                        desc += '0';
                    }
                    desc += value.toString(16);
                }
            }
            return desc;
        }
    }
    log(`Miss support of ${codec} codec`).error();
    return '';
}

export function readCodecString(codecString: string, out: { codec: Media.Codec; type: Media.Type }): boolean {
    // Determine codec from codecString
    const fields = codecString.split('.');
    if ((fields[0]?.trim() || '') === 'mp4a') {
        fields.shift();
    }
    let codec = (fields[0]?.trim() || '').toLowerCase();
    switch (codec) {
        case '40':
            codec = fields[1]?.trim() || '';
        // eslint-disable-next-line no-fallthrough
        case 'aac': {
            if (codec !== '34') {
                out.codec = Media.Codec.AAC;
                out.type = Media.Type.AUDIO;
                return true;
            }
            // mp4a.40.34 => MP3on4 Layer 3 : MP3 into MP4
        }
        // eslint-disable-next-line no-fallthrough
        case 'mp3':
        case '6b': // Audio ISO/IEC 11172-3 (MPEG-1 Audio, MP3)
            out.codec = Media.Codec.MP3;
            out.type = Media.Type.AUDIO;
            return true;
        case 'avc1':
        case 'avc2':
        case 'avc3':
        case 'avc4':
        case 'h264':
        case 'x264':
        case '264':
            out.codec = Media.Codec.H264;
            out.type = Media.Type.VIDEO;
            return true;
        default:
    }
    return false;
}

/**
 * Decode sps to resolution/rate just if there are not already set
 * @param sps
 * @param out
 * @returns
 */
export function parseSPS(sps: Uint8Array, out: { resolution: Media.Resolution; rate: number }): boolean {
    const reader = new BitReader(sps);
    if ((reader.read8() & 0x1f) !== 7) {
        log('Invalid SPS data').error();
        return false;
    }

    let leftOffset = 0,
        rightOffset = 0,
        topOffset = 0,
        bottomOffset = 0;
    let subWidthC = 0,
        subHeightC = 0;

    const idc = reader.read8();
    reader.next(16); // constraincts
    reader.readExpGolomb(); // seq_parameter_set_id

    switch (idc) {
        case 44:
        case 83:
        case 86:
        case 100:
        case 110:
        case 118:
        case 122:
        case 128:
        case 138:
        case 144:
        case 244: {
            const chroma_format_idc = reader.readExpGolomb();
            switch (chroma_format_idc) {
                case 1: // 4:2:0
                    subWidthC = subHeightC = 2;
                    break;
                case 2: // 4:2:2
                    subWidthC = 2;
                    subHeightC = 1;
                    break;
                case 3: // 4:4:4
                    if (!reader.read()) {
                        subWidthC = subHeightC = 1; // separate_colour_plane_flag
                    }
                    break;
            }

            reader.readExpGolomb(); // bit_depth_luma_minus8
            reader.readExpGolomb(); // bit_depth_chroma_minus8
            reader.next(); // qpprime_y_zero_transform_bypass_flag
            if (reader.read()) {
                // seq_scaling_matrix_present_flag
                for (let i = 0; i < (chroma_format_idc !== 3 ? 8 : 12); ++i) {
                    if (reader.read()) {
                        // seq_scaling_list_present_flag
                        const sizeOfScalingList = i < 6 ? 16 : 64;
                        let scale = 8;
                        for (let j = 0; j < sizeOfScalingList; ++j) {
                            let delta = reader.readExpGolomb();
                            if (delta & 1) {
                                delta = (delta + 1) / 2;
                            } else {
                                delta = -(delta / 2);
                            }
                            scale = (scale + delta + 256) % 256;
                            if (!scale) {
                                break;
                            }
                        }
                    }
                }
            }
            break;
        }
    }

    reader.readExpGolomb(); // log2_max_frame_num_minus4
    const picOrderCntType = reader.readExpGolomb();
    if (!picOrderCntType) {
        reader.readExpGolomb(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
        reader.next(); // delta_pic_order_always_zero_flag
        reader.readExpGolomb(); // offset_for_non_ref_pic
        reader.readExpGolomb(); // offset_for_top_to_bottom_field
        const refFrames = reader.readExpGolomb();
        for (let i = 0; i < refFrames; ++i) {
            reader.readExpGolomb(); // sps->offset_for_ref_frame[ i ] = ReadSE();
        }
    }
    reader.readExpGolomb(); // max_num_ref_frames
    reader.next(); // gaps_in_frame_num_value_allowed_flag
    const picWidth = (reader.readExpGolomb() + 1) * 16;
    let picHeight = (reader.readExpGolomb() + 1) * 16;
    if (!reader.read()) {
        // frame_mbs_only_flag
        picHeight *= 2;
        subHeightC *= 2;
        reader.next(); // mb_adaptive_frame_field_flag
    }

    reader.next(); // direct_8x8_inference_flag
    if (reader.read()) {
        // frame_cropping_flag
        leftOffset = reader.readExpGolomb();
        rightOffset = reader.readExpGolomb();
        topOffset = reader.readExpGolomb();
        bottomOffset = reader.readExpGolomb();
    }

    if (!out.resolution.width) {
        out.resolution.width = picWidth - subWidthC * (leftOffset + rightOffset);
    }
    if (!out.resolution.height) {
        out.resolution.height = picHeight - subHeightC * (topOffset + bottomOffset);
    }
    if (out.rate) {
        // no need to continue parsing!
        return true;
    }

    if (reader.read()) {
        // vui_parameters_present_flag
        // parse H2645VUI, https://ffmpeg.org/doxygen/trunk/h2645__vui_8c_source.html
        if (reader.read()) {
            // aspect_ratio_info_present_flag
            const aspect_ratio_idc = reader.read8();
            if (aspect_ratio_idc === 255) {
                // EXTENDED_SAR
                reader.read16(); // sar_width
                reader.read16(); // sar_height
            }
        }
        if (reader.read()) {
            // overscan_info_present_flag
            reader.next(); // overscan_appropriate_flag
        }
        if (reader.read()) {
            // video_signal_type_present_flag
            reader.read(3); // video_format
            reader.read(); // video_full_range_flag
            if (reader.read()) {
                // colour_description_present_flag
                reader.read8(); // colour_primaries
                reader.read8(); // transfer_characteristics
                reader.read8(); // matrix_coefficients
            }
        }
        if (reader.read()) {
            // chroma_loc_info_present_flag
            reader.readExpGolomb(); // chroma_sample_loc_type_top_field
            reader.readExpGolomb(); // chroma_sample_loc_type_bottom_field
        }
    }

    if (reader.read()) {
        // timing_info_present_flag
        const num_units_in_tick = reader.read32();
        const time_scale = reader.read32();
        if (num_units_in_tick && reader.read()) {
            // fixed_frame_rate_flag
            // we can compute fps!
            out.rate = time_scale / (2 * num_units_in_tick);
        }
    }

    return true;
}
