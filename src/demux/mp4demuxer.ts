/**
 * MP4 demuxer
 */
import {
  Demuxer,
  DemuxerResult,
  PassthroughVideoTrack,
  DemuxedAudioTrack,
  DemuxedUserdataTrack,
  DemuxedMetadataTrack,
  KeyData,
} from '../types/demuxer';
import {
  findBox,
  segmentValidRange,
  appendUint8Array,
  parseEmsg,
  parseEarlieastPresentationTime,
} from '../utils/mp4-tools';
import { dummyTrack } from './dummy-demuxed-track';
import type { HlsEventEmitter } from '../events';
import type { HlsConfig } from '../config';

// Support scheme
//   'https://aomedia.org/emsg/ID3',
//   'https://developer.apple.com/streaming/emsg-id3',
//    urn:scte:scte35:2013:xml
const emsgSchemePattern = /\/emsg[-/]ID3|urn:scte:scte35:2013:xml/i;

class MP4Demuxer implements Demuxer {
  static readonly minProbeByteLength = 1024;
  private remainderData: Uint8Array | null = null;
  private timeOffset: number = 0;
  private config: HlsConfig;

  constructor(observer: HlsEventEmitter, config: HlsConfig) {
    this.config = config;
  }

  resetTimeStamp() {}

  resetInitSegment() {
    this.timeOffset = 0;
  }

  resetContiguity(): void {}

  static probe(data) {
    // ensure we find a moof box in the first 16 kB
    return (
      findBox({ data: data, start: 0, end: Math.min(data.length, 16384) }, [
        'moof',
      ]).length > 0
    );
  }

  demux(data: Uint8Array, timeOffset: number): DemuxerResult {
    this.timeOffset = timeOffset;
    // Load all data into the avc track. The CMAF remuxer will look for the data in the samples object; the rest of the fields do not matter
    let avcSamples = data;
    const avcTrack = dummyTrack() as PassthroughVideoTrack;
    if (this.config.progressive) {
      // Split the bytestream into two ranges: one encompassing all data up until the start of the last moof, and everything else.
      // This is done to guarantee that we're sending valid data to MSE - when demuxing progressively, we have no guarantee
      // that the fetch loader gives us flush moof+mdat pairs. If we push jagged data to MSE, it will throw an exception.
      if (this.remainderData) {
        avcSamples = appendUint8Array(this.remainderData, data);
      }
      const segmentedData = segmentValidRange(avcSamples);
      this.remainderData = segmentedData.remainder;
      avcTrack.samples = segmentedData.valid || new Uint8Array();
    } else {
      avcTrack.samples = avcSamples;
    }

    const id3Track = this.extractID3Track(avcTrack, timeOffset);

    return {
      audioTrack: dummyTrack() as DemuxedAudioTrack,
      avcTrack,
      id3Track,
      textTrack: dummyTrack() as DemuxedUserdataTrack,
    };
  }

  flush() {
    const avcTrack = dummyTrack() as PassthroughVideoTrack;
    avcTrack.samples = this.remainderData || new Uint8Array();
    this.remainderData = null;

    const id3Track = this.extractID3Track(avcTrack, this.timeOffset);
    return {
      audioTrack: dummyTrack() as DemuxedAudioTrack,
      avcTrack,
      id3Track,
      textTrack: dummyTrack() as DemuxedUserdataTrack,
    };
  }

  private extractID3Track(
    videoTrack: PassthroughVideoTrack,
    timeOffset: number
  ): DemuxedMetadataTrack {
    const id3Track = dummyTrack() as DemuxedMetadataTrack;
    id3Track.type = 'id3';
    id3Track.inputTimeScale = 1;
    if (videoTrack.samples.length) {
      let earliestPresentationTime = 0;
      const sidxInfo = parseEarlieastPresentationTime(videoTrack.samples);
      if (sidxInfo) {
        earliestPresentationTime = sidxInfo.earliestPresentationTime / sidxInfo.timescale;
      }
      const emsgs = findBox(videoTrack.samples, ['emsg']);
      if (emsgs) {
        emsgs.forEach(({data, start, end}) => {
          const emsgInfo = parseEmsg(data.subarray(start, end));
          if (emsgSchemePattern.test(emsgInfo.schemeIdUri)) {
            const pts = !Number.isFinite(emsgInfo.presentationTimeDelta)
              ? emsgInfo.presentationTime! / emsgInfo.timeScale
              : timeOffset + earliestPresentationTime +
                emsgInfo.presentationTimeDelta! / emsgInfo.timeScale;
            const payload = emsgInfo.payload;
            id3Track.samples.push({
              data: payload,
              len: payload.byteLength,
              dts: pts,
              pts: pts,
            });
          }
        });
      }
    }
    return id3Track;
  }

  demuxSampleAes(
    data: Uint8Array,
    keyData: KeyData,
    timeOffset: number
  ): Promise<DemuxerResult> {
    return Promise.reject(
      new Error('The MP4 demuxer does not support SAMPLE-AES decryption')
    );
  }

  destroy() {}
}

export default MP4Demuxer;
