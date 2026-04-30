import { expect } from 'chai';
import MP4 from '../../../src/remux/mp4-generator';
import {
  bin2str,
  fakeEncryption,
  findBox,
  parseInitSegment,
} from '../../../src/utils/mp4-tools';
import type { DemuxedAVC1 } from '../../../src/types/demuxer';
import type { DemuxedAudioTrack } from '../../../src/types/demuxer';

// Minimal H.264 High profile SPS and PPS — enough for MP4 generator to produce a valid avc1 box
const MINIMAL_SPS = new Uint8Array([0x67, 0x64, 0x00, 0x1e, 0xac, 0xd9]);
const MINIMAL_PPS = new Uint8Array([0x68, 0xce, 0x38, 0x80]);

function makeVideoTrack(): DemuxedAVC1 {
  return {
    id: 1,
    pid: 1,
    type: 'video',
    segmentCodec: 'avc',
    inputTimeScale: 90000,
    timescale: 90000,
    duration: 0,
    width: 320,
    height: 240,
    pixelRatio: [1, 1],
    sps: [MINIMAL_SPS],
    pps: [MINIMAL_PPS],
    samples: [],
    dropped: 0,
    sequenceNumber: 0,
  };
}

function makeAudioTrack(): DemuxedAudioTrack {
  return {
    id: 2,
    pid: 2,
    type: 'audio',
    segmentCodec: 'aac',
    inputTimeScale: 48000,
    timescale: 48000,
    duration: 0,
    channelCount: 2,
    samplerate: 48000,
    config: [0x11, 0x90], // AAC-LC, 48 kHz, 2ch
    samples: [],
    dropped: 0,
    sequenceNumber: 0,
  };
}

function makeClearVideoInitSegment(): Uint8Array<ArrayBuffer> {
  MP4.init();
  return MP4.initSegment([makeVideoTrack()]) as Uint8Array<ArrayBuffer>;
}

function makeClearAudioVideoInitSegment(): Uint8Array<ArrayBuffer> {
  MP4.init();
  return MP4.initSegment([
    makeVideoTrack(),
    makeAudioTrack(),
  ]) as Uint8Array<ArrayBuffer>;
}

describe('fakeEncryption', function () {
  describe('video-only init segment', function () {
    let result: Uint8Array<ArrayBuffer>;

    beforeEach(function () {
      result = fakeEncryption(makeClearVideoInitSegment());
    });

    it('replaces avc1 sample entry with encv', function () {
      const stsd = findBox(result, [
        'moov',
        'trak',
        'mdia',
        'minf',
        'stbl',
        'stsd',
      ])[0];
      // sampleEntries starts at stsd+8 (skipping stsd version/flags)

      const sampleEntries = stsd.subarray(8);
      const fourCC = bin2str(sampleEntries.subarray(4, 8));
      expect(fourCC).to.equal('encv');
    });

    it('encv contains a sinf box', function () {
      const stsd = findBox(result, [
        'moov',
        'trak',
        'mdia',
        'minf',
        'stbl',
        'stsd',
      ])[0];
      const encv = findBox(stsd.subarray(8), ['encv'])[0];
      // encv children start after 78 bytes of video sample entry header
      const sinfs = findBox(encv.subarray(78), ['sinf']);
      expect(sinfs).to.have.length(1);
    });

    it('sinf/frma contains the original avc1 codec', function () {
      const stsd = findBox(result, [
        'moov',
        'trak',
        'mdia',
        'minf',
        'stbl',
        'stsd',
      ])[0];
      const encv = findBox(stsd.subarray(8), ['encv'])[0];
      const sinf = findBox(encv.subarray(78), ['sinf'])[0];
      const frma = findBox(sinf, ['frma'])[0];
      expect(bin2str(frma)).to.equal('avc1');
    });

    it('sinf/schm declares cenc scheme', function () {
      const stsd = findBox(result, [
        'moov',
        'trak',
        'mdia',
        'minf',
        'stbl',
        'stsd',
      ])[0];
      const encv = findBox(stsd.subarray(8), ['encv'])[0];
      const sinf = findBox(encv.subarray(78), ['sinf'])[0];
      const schm = findBox(sinf, ['schm'])[0];
      // scheme_type is at bytes 4–7 of schm content (after version/flags)
      expect(bin2str(schm.subarray(4, 8))).to.equal('cenc');
    });

    it('tenc sets default_isProtected = 1', function () {
      const stsd = findBox(result, [
        'moov',
        'trak',
        'mdia',
        'minf',
        'stbl',
        'stsd',
      ])[0];
      const encv = findBox(stsd.subarray(8), ['encv'])[0];
      const sinf = findBox(encv.subarray(78), ['sinf'])[0];
      const tenc = findBox(sinf, ['schi', 'tenc'])[0];
      // tenc layout: [0–3] version/flags, [4–5] reserved, [6] isProtected, [7] IV size, [8–23] KID
      expect(tenc[6]).to.equal(1);
    });

    it('tenc sets default_Per_Sample_IV_Size = 8', function () {
      const stsd = findBox(result, [
        'moov',
        'trak',
        'mdia',
        'minf',
        'stbl',
        'stsd',
      ])[0];
      const encv = findBox(stsd.subarray(8), ['encv'])[0];
      const sinf = findBox(encv.subarray(78), ['sinf'])[0];
      const tenc = findBox(sinf, ['schi', 'tenc'])[0];
      expect(tenc[7]).to.equal(8);
    });

    it('tenc default_KID is all zeros (to be patched later)', function () {
      const stsd = findBox(result, [
        'moov',
        'trak',
        'mdia',
        'minf',
        'stbl',
        'stsd',
      ])[0];
      const encv = findBox(stsd.subarray(8), ['encv'])[0];
      const sinf = findBox(encv.subarray(78), ['sinf'])[0];
      const tenc = findBox(sinf, ['schi', 'tenc'])[0];
      const kid = tenc.subarray(8, 24);
      expect(kid.every((b) => b === 0)).to.be.true;
    });

    it('parseInitSegment reports video track as encrypted', function () {
      const parsed = parseInitSegment(result);
      expect(parsed.video?.encrypted).to.be.true;
    });

    it('parseInitSegment preserves the avc1 codec string', function () {
      const parsed = parseInitSegment(result);
      expect(parsed.video?.codec).to.match(/^avc1/);
    });
  });

  describe('audio+video init segment', function () {
    let result: Uint8Array<ArrayBuffer>;

    beforeEach(function () {
      result = fakeEncryption(makeClearAudioVideoInitSegment());
    });

    it('replaces mp4a sample entry with enca', function () {
      const traks = findBox(result, ['moov', 'trak']);
      const audioTrak = traks.find((trak) => {
        const hdlr = findBox(trak, ['mdia', 'hdlr'])[0];
        return hdlr && bin2str(hdlr.subarray(8, 12)) === 'soun';
      });
      expect(audioTrak).to.exist;
      const stsd = findBox(audioTrak!, [
        'mdia',
        'minf',
        'stbl',
        'stsd',
      ])[0];
      const sampleEntries = stsd.subarray(8);
      const fourCC = bin2str(sampleEntries.subarray(4, 8));
      expect(fourCC).to.equal('enca');
    });

    it('enca sinf/frma contains the original mp4a codec', function () {
      const traks = findBox(result, ['moov', 'trak']);
      const audioTrak = traks.find((trak) => {
        const hdlr = findBox(trak, ['mdia', 'hdlr'])[0];
        return hdlr && bin2str(hdlr.subarray(8, 12)) === 'soun';
      });
      const stsd = findBox(audioTrak!, ['mdia', 'minf', 'stbl', 'stsd'])[0];
      const enca = findBox(stsd.subarray(8), ['enca'])[0];
      // enca children start after 28 bytes of audio sample entry header
      const sinf = findBox(enca.subarray(28), ['sinf'])[0];
      const frma = findBox(sinf, ['frma'])[0];
      expect(bin2str(frma)).to.equal('mp4a');
    });

    it('parseInitSegment reports both tracks as encrypted', function () {
      const parsed = parseInitSegment(result);
      expect(parsed.video?.encrypted).to.be.true;
      expect(parsed.audio?.encrypted).to.be.true;
    });
  });

  describe('already-encrypted init segment', function () {
    it('is returned unchanged when video track is already encv', function () {
      const clear = makeClearVideoInitSegment();
      const encrypted = fakeEncryption(clear);
      const doubleEncrypted = fakeEncryption(encrypted);
      // The stsd should still have encv, not encv wrapping encv
      const stsd = findBox(doubleEncrypted, [
        'moov',
        'trak',
        'mdia',
        'minf',
        'stbl',
        'stsd',
      ])[0];
      const sampleEntries = stsd.subarray(8);
      expect(bin2str(sampleEntries.subarray(4, 8))).to.equal('encv');
      // frma should still be avc1, not encv
      const encv = findBox(sampleEntries, ['encv'])[0];
      const sinf = findBox(encv.subarray(78), ['sinf'])[0];
      const frma = findBox(sinf, ['frma'])[0];
      expect(bin2str(frma)).to.equal('avc1');
    });
  });
});
