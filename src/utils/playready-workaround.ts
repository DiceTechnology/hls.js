import { logger } from './logger';
import { KeySystemFormats } from './mediakeys-helper';
import {
  bin2str,
  dumpSegment,
  findBox,
  readUint16,
  readUint32,
  writeUint32,
} from './mp4-tools';
import type { Fragment, MediaFragment } from '../hls';
import type { LevelDetails } from '../loader/level-details';

/**
 * Applies a PlayReady DRM workaround to level details.
 *
 * This function addresses PlayReady DRM compatibility issues by copying
 * levelkeys from the first encrypted fragment to all fragments that lack
 * levelkeys. This ensures smooth transitions in mixed clear and encrypted
 * content playlists on certain platforms like XBox.
 *
 * @param levelDetails - The level details object to apply the workaround to
 */
export function applyPlayReadyWorkaroundToLevelDetails(
  levelDetails: LevelDetails,
) {
  const firstEncryptedFragment = levelDetails.encryptedFragments?.[0];
  if (firstEncryptedFragment?.levelkeys?.[KeySystemFormats.PLAYREADY]) {
    for (let i = 0; i < levelDetails.fragments.length; i++) {
      const fragment = levelDetails.fragments[i];
      if (!fragment.levelkeys) {
        fragment.levelkeys = firstEncryptedFragment.levelkeys;
      }
    }
    logger.debug('Applied PlayReady workaround to level details');
  }
}

export function patchClearMediaSegment(
  clearSegmentData: Uint8Array,
  firstEncryptedSegmentData: Uint8Array,
  saioOffsetMode: 'moof-relative' | 'file-relative' = 'moof-relative',
  clearPrerollCencMode:
    | 'sgpd-sbgp'
    | 'aux-info-only'
    | 'mirror-encrypted-aux-info'
    | 'mirror-encrypted-senc-shape' = 'sgpd-sbgp',
): Uint8Array {
  dumpSegment(
    '$$$$ Clear media segment before CENC sample-group patch',
    clearSegmentData,
    'clear media',
  );

  const moofArr = findBox(clearSegmentData, ['moof']);
  if (!moofArr.length) {
    logger.warn('[playready-workaround] patchClearMediaSegment: no moof found');
    return clearSegmentData;
  }
  const moof = moofArr[0];

  const trafArr = findBox(moof, ['traf']);
  if (!trafArr.length) {
    logger.warn('[playready-workaround] patchClearMediaSegment: no traf found');
    return clearSegmentData;
  }
  const traf = trafArr[0];

  const trunArr = findBox(traf, ['trun']);
  if (!trunArr.length) {
    logger.warn('[playready-workaround] patchClearMediaSegment: no trun found');
    return clearSegmentData;
  }
  const trun = trunArr[0];

  const trunFlags = parseTrunFlags(trun);
  const sampleCount = readUint32(trun, 4);
  const dataOffsetPresent = !!(trunFlags & 0x000001);
  const auxInfoOnly = clearPrerollCencMode === 'aux-info-only';
  const mirrorMode = clearPrerollCencMode === 'mirror-encrypted-aux-info';
  const mirrorSencShape =
    clearPrerollCencMode === 'mirror-encrypted-senc-shape';
  const useUntypedBoxes = mirrorMode || mirrorSencShape;
  const noSampleGroups = auxInfoOnly || mirrorMode || mirrorSencShape;

  // Guard: abort if seig sbgp already present (segment was already patched in sgpd-sbgp mode)
  const sbgpArr = findBox(traf, ['sbgp']);
  for (let i = 0; i < sbgpArr.length; i++) {
    if (bin2str(sbgpArr[i].subarray(4, 8)) === 'seig') {
      logger.debug(
        '[playready-workaround] patchClearMediaSegment: seig already present, skipping',
      );
      return clearSegmentData;
    }
  }
  // In aux-info-only and mirror-encrypted-aux-info modes also guard against re-patching via senc presence
  if (noSampleGroups && findBox(traf, ['senc']).length > 0) {
    logger.debug(
      '[playready-workaround] patchClearMediaSegment: senc already present, skipping',
    );
    return clearSegmentData;
  }

  // Determine insertion offset.
  // aux-info-only / mirror-encrypted-aux-info: always right after trun (produces trun → saiz → saio → senc order).
  // sgpd-sbgp: after roll sbgp if present (preserves standard sample-group ordering).
  let insertionOffset = trun.byteOffset + trun.length;
  if (!noSampleGroups) {
    for (let i = 0; i < sbgpArr.length; i++) {
      if (bin2str(sbgpArr[i].subarray(4, 8)) === 'roll') {
        insertionOffset = sbgpArr[i].byteOffset + sbgpArr[i].length;
      }
    }
  }

  // Resolve per-sample sizes for the senc box
  let sampleSizes = readTrunSampleSizes(trun, trunFlags, sampleCount);
  if (!sampleSizes.length) {
    const defaultSize = readTfhdDefaultSampleSize(traf);
    if (defaultSize > 0) {
      sampleSizes = new Array(sampleCount).fill(defaultSize) as number[];
    } else {
      logger.warn(
        '[playready-workaround] patchClearMediaSegment: cannot determine sample sizes; senc will not be added',
      );
    }
  }

  // Build sgpd(seig) and sbgp(seig) only in sgpd-sbgp mode
  let sgpdSeig: Uint8Array | null = null;
  let sbgpSeig: Uint8Array | null = null;
  if (!noSampleGroups) {
    // sgpd(seig) — 44 bytes
    // Layout: size(4) + "sgpd"(4) + version=1/flags=0(4) + grouping_type="seig"(4) +
    //         default_length=20(4) + entry_count=1(4) + entry(20)
    // Entry: isProtected=0(3) + perSampleIvSize=0(1) + zero-KID(16) — all zero
    sgpdSeig = new Uint8Array(44);
    writeUint32(sgpdSeig, 0, 44);
    sgpdSeig[4] = 0x73;
    sgpdSeig[5] = 0x67;
    sgpdSeig[6] = 0x70;
    sgpdSeig[7] = 0x64; // "sgpd"
    sgpdSeig[8] = 0x01; // version=1
    sgpdSeig[12] = 0x73;
    sgpdSeig[13] = 0x65;
    sgpdSeig[14] = 0x69;
    sgpdSeig[15] = 0x67; // "seig"
    writeUint32(sgpdSeig, 16, 20); // default_length
    writeUint32(sgpdSeig, 20, 1); // entry_count
    // bytes 24-43: entry (all zero — isProtected=0, perSampleIvSize=0, KID=0×16)

    // sbgp(seig) — 28 bytes
    // Layout: size(4) + "sbgp"(4) + version=0/flags=0(4) + grouping_type="seig"(4) +
    //         entry_count=1(4) + sample_count(4) + group_description_index=1(4)
    sbgpSeig = new Uint8Array(28);
    writeUint32(sbgpSeig, 0, 28);
    sbgpSeig[4] = 0x73;
    sbgpSeig[5] = 0x62;
    sbgpSeig[6] = 0x67;
    sbgpSeig[7] = 0x70; // "sbgp"
    // bytes 8-11: version=0, flags=0 (already zero)
    sbgpSeig[12] = 0x73;
    sbgpSeig[13] = 0x65;
    sbgpSeig[14] = 0x69;
    sbgpSeig[15] = 0x67; // "seig"
    writeUint32(sbgpSeig, 16, 1); // entry_count
    writeUint32(sbgpSeig, 20, sampleCount); // sample_count
    writeUint32(sbgpSeig, 24, 1); // group_description_index
  }

  // In mirror-encrypted-senc-shape mode, extract the raw senc box bytes from the first
  // encrypted media segment so the patched clear senc is byte-for-byte identical.
  let encryptedSencBox: Uint8Array | null = null;
  if (mirrorSencShape) {
    encryptedSencBox = extractEncryptedSencBox(firstEncryptedSegmentData);
    if (!encryptedSencBox) {
      logger.warn(
        '[playready-workaround] patchClearMediaSegment: could not extract encrypted senc box; aborting patch',
      );
      return clearSegmentData;
    }
    const encSampleCount = readUint32(encryptedSencBox, 12);
    if (encSampleCount !== sampleCount) {
      logger.warn(
        `[playready-workaround] patchClearMediaSegment: encrypted senc.sample_count ${encSampleCount} !== clear trun.sample_count ${sampleCount}; aborting patch`,
      );
      return clearSegmentData;
    }
  }

  // Build senc box — in mirrorSencShape mode use the raw encrypted senc bytes directly.
  const sencBox: Uint8Array | null = mirrorSencShape
    ? encryptedSencBox
    : sampleSizes.length
      ? buildSencBox(sampleSizes)
      : null;
  // Validate clear-only senc (not applicable when senc carries real encrypted records)
  if (sencBox && !mirrorSencShape) {
    validateSencBox(sencBox, sampleSizes, sampleCount);
  }

  const SGPD_SBGP_BYTES = 72; // 44 (sgpd) + 28 (sbgp)
  const moofStart = moof.byteOffset - 8;

  // Build saiz and saio to advertise inline senc auxiliary data to the parser.
  // useUntypedBoxes (mirror-encrypted-aux-info / mirror-encrypted-senc-shape) uses
  // untyped (flags=0) saiz/saio matching the real encrypted segment structure.
  // aux-info-only and sgpd-sbgp use typed (flags=0x000001, aux_info_type="cenc") saiz/saio.
  const saizBox = sencBox
    ? useUntypedBoxes
      ? mirrorSencShape && encryptedSencBox
        ? buildUntypedSaizFromRawSencBox(encryptedSencBox)
        : buildUntypedSaizBox(sampleCount)
      : buildSaizBox(sampleSizes)
    : null;
  // Bytes prepended before saiz in the assembled gap: 0 when no sample groups, 72 in sgpd-sbgp.
  const extraBytes = noSampleGroups ? 0 : SGPD_SBGP_BYTES;
  // Compute where senc will land in the assembled buffer so the saio offset is accurate.
  // saio size: 20 bytes untyped (mirror modes), 28 bytes typed (other modes).
  const saioBoxSize = useUntypedBoxes ? 20 : 28;
  const sencStartInPatched =
    sencBox && saizBox
      ? insertionOffset + extraBytes + saizBox.length + saioBoxSize
      : -1;
  // First IV is 16 bytes into senc: size(4)+type(4)+version/flags(4)+sample_count(4) = 16
  const firstIvAbsolute =
    sencStartInPatched !== -1 ? sencStartInPatched + 16 : 0;
  const saioOffsetValue =
    sencStartInPatched !== -1
      ? saioOffsetMode === 'moof-relative'
        ? firstIvAbsolute - moofStart
        : firstIvAbsolute
      : 0;
  const saioBox = sencBox
    ? useUntypedBoxes
      ? buildUntypedSaioBox(saioOffsetValue)
      : buildSaioBox(saioOffsetValue)
    : null;

  const INSERTED_BYTES =
    extraBytes +
    (saizBox ? saizBox.length : 0) +
    (saioBox ? saioBox.length : 0) +
    (sencBox ? sencBox.length : 0);

  // Assemble patched segment
  const newData = new Uint8Array(clearSegmentData.length + INSERTED_BYTES);
  newData.set(clearSegmentData.subarray(0, insertionOffset), 0);
  let insertPos = insertionOffset;
  if (!auxInfoOnly && sgpdSeig && sbgpSeig) {
    newData.set(sgpdSeig, insertPos);
    newData.set(sbgpSeig, insertPos + 44);
    insertPos += SGPD_SBGP_BYTES;
  }
  if (saizBox) {
    newData.set(saizBox, insertPos);
    insertPos += saizBox.length;
  }
  if (saioBox) {
    newData.set(saioBox, insertPos);
    insertPos += saioBox.length;
  }
  if (sencBox) {
    newData.set(sencBox, insertPos);
  }
  newData.set(
    clearSegmentData.subarray(insertionOffset),
    insertionOffset + INSERTED_BYTES,
  );

  // Update moof.size and traf.size — both box headers are before insertionOffset
  // so their positions in newData are unchanged
  writeUint32(
    newData,
    moofStart,
    readUint32(newData, moofStart) + INSERTED_BYTES,
  );
  const trafSizeOffset = traf.byteOffset - 8;
  writeUint32(
    newData,
    trafSizeOffset,
    readUint32(newData, trafSizeOffset) + INSERTED_BYTES,
  );

  // If trun.data_offset is present, bump it by the number of bytes inserted before mdat
  if (dataOffsetPresent) {
    const trunDataOffsetPos = trun.byteOffset + 8; // after version(1)+flags(3)+sample_count(4)
    writeUint32(
      newData,
      trunDataOffsetPos,
      readUint32(newData, trunDataOffsetPos) + INSERTED_BYTES,
    );
  }

  // Update sidx referenced_size if a sidx box precedes moof
  updateSidxReferencedSize(
    clearSegmentData,
    newData,
    INSERTED_BYTES,
    moofStart,
  );

  validatePatchedSegment(
    clearSegmentData,
    newData,
    INSERTED_BYTES,
    moofStart,
    trafSizeOffset,
    dataOffsetPresent ? trun.byteOffset + 8 : -1,
  );

  if (sencBox && saizBox && saioBox) {
    validateSaizSaioSenc(
      newData,
      sampleCount,
      saioOffsetValue,
      saioOffsetMode,
      clearPrerollCencMode,
      mirrorSencShape ? encryptedSencBox : null,
    );
  }

  dumpSegment(
    '$$$$ Clear media segment after CENC sample-group patch',
    newData,
    'patched media',
  );
  return newData;
}

// Returns the 24-bit flags field from a trun box content (after the 8-byte box header).
function parseTrunFlags(trun: Uint8Array): number {
  return (trun[1] << 16) | (trun[2] << 8) | trun[3];
}

// Returns per-sample sizes from trun when sample-size-present (0x000200) is set.
// Returns an empty array if the flag is absent — caller must resolve via tfhd default.
function readTrunSampleSizes(
  trun: Uint8Array,
  flags: number,
  sampleCount: number,
): number[] {
  if (!(flags & 0x000200)) return [];

  // Skip to the first per-sample entry after version(1)+flags(3)+sample_count(4)=8
  let offset = 8;
  if (flags & 0x000001) offset += 4; // data_offset
  if (flags & 0x000004) offset += 4; // first_sample_flags

  // Per-sample stride and offset of the size field within each entry
  const hasDuration = !!(flags & 0x000100);
  const hasFlags = !!(flags & 0x000400);
  const hasComposition = !!(flags & 0x000800);
  const sizeFieldOffset = hasDuration ? 4 : 0;
  const perSampleStride =
    (hasDuration ? 4 : 0) + 4 + (hasFlags ? 4 : 0) + (hasComposition ? 4 : 0);

  const sizes: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    sizes.push(
      readUint32(trun, offset + i * perSampleStride + sizeFieldOffset),
    );
  }
  return sizes;
}

// Returns the default_sample_size from tfhd (flag 0x000010), or 0 if not present.
function readTfhdDefaultSampleSize(traf: Uint8Array): number {
  const tfhdArr = findBox(traf, ['tfhd']);
  if (!tfhdArr.length) return 0;
  const tfhd = tfhdArr[0];
  const flags = (tfhd[1] << 16) | (tfhd[2] << 8) | tfhd[3];
  let offset = 8; // version(1)+flags(3)+track_id(4)
  if (flags & 0x000001) offset += 8; // base_data_offset (64-bit)
  if (flags & 0x000002) offset += 4; // sample_description_index
  if (flags & 0x000008) offset += 4; // default_sample_duration
  if (flags & 0x000010) return readUint32(tfhd, offset);
  return 0;
}

// Extracts the raw senc box bytes (header + content) from the first encrypted media segment.
// Returns a copy so the returned slice is independent of the source buffer.
// Returns null if moof/traf/senc is absent or senc.flags !== 0x000002.
function extractEncryptedSencBox(encryptedData: Uint8Array): Uint8Array | null {
  const moofArr = findBox(encryptedData, ['moof']);
  if (!moofArr.length) {
    logger.warn(
      '[playready-workaround] extractEncryptedSencBox: no moof in encrypted segment',
    );
    return null;
  }
  const trafArr = findBox(moofArr[0], ['traf']);
  if (!trafArr.length) {
    logger.warn(
      '[playready-workaround] extractEncryptedSencBox: no traf in encrypted moof',
    );
    return null;
  }
  const sencArr = findBox(trafArr[0], ['senc']);
  if (!sencArr.length) {
    logger.warn(
      '[playready-workaround] extractEncryptedSencBox: no senc in encrypted traf',
    );
    return null;
  }
  const senc = sencArr[0]; // content slice (after the 8-byte box header)
  const flags = (senc[1] << 16) | (senc[2] << 8) | senc[3];
  if (flags !== 0x000002) {
    logger.warn(
      `[playready-workaround] extractEncryptedSencBox: unexpected senc flags 0x${flags.toString(16).padStart(6, '0')}`,
    );
    return null;
  }
  // senc.byteOffset is absolute in the backing ArrayBuffer (assumed byteOffset=0 for top-level data).
  return encryptedData.slice(
    senc.byteOffset - 8,
    senc.byteOffset + senc.length,
  );
}

// Builds an untyped saiz box by walking a raw senc box's per-sample records.
// rawSencBox must include the 8-byte box header (size + "senc").
// Uses compact form when all per-sample aux sizes are equal; per-sample array otherwise.
// Returns null if the senc structure is malformed.
function buildUntypedSaizFromRawSencBox(
  rawSencBox: Uint8Array,
): Uint8Array | null {
  // rawSencBox layout: size(4)+type(4)+version/flags(4)+sample_count(4) = 16 bytes header,
  // then per-sample records: IV(16)+subsample_count(2)+N×[clear(2)+protected(4)]
  if (rawSencBox.length < 16) return null;
  const sampleCount = readUint32(rawSencBox, 12);
  const auxSizes: number[] = [];
  let pos = 16;
  let uniform = true;
  for (let i = 0; i < sampleCount; i++) {
    if (pos + 18 > rawSencBox.length) return null; // IV(16) + subsample_count(2)
    const subsampleCount = (rawSencBox[pos + 16] << 8) | rawSencBox[pos + 17];
    const sz = 18 + 6 * subsampleCount; // IV(16) + count(2) + N×6
    auxSizes.push(sz);
    if (i > 0 && sz !== auxSizes[0]) uniform = false;
    pos += sz;
  }

  if (uniform && sampleCount > 0) {
    const box = new Uint8Array(17); // compact untyped saiz
    writeUint32(box, 0, 17);
    box[4] = 0x73;
    box[5] = 0x61;
    box[6] = 0x69;
    box[7] = 0x7a; // "saiz"
    // version=0, flags=0 (bytes 8-11 zero)
    box[12] = auxSizes[0]; // default_sample_info_size
    writeUint32(box, 13, sampleCount);
    return box;
  }

  // Per-sample untyped saiz
  const totalSize = 17 + sampleCount;
  const box = new Uint8Array(totalSize);
  writeUint32(box, 0, totalSize);
  box[4] = 0x73;
  box[5] = 0x61;
  box[6] = 0x69;
  box[7] = 0x7a; // "saiz"
  // version=0, flags=0, default_sample_info_size=0 (bytes 8-12 zero)
  writeUint32(box, 13, sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    box[17 + i] = auxSizes[i];
  }
  return box;
}

// Generates a deterministic, non-repeating 16-byte IV for the given sample index.
// The counter (index + 1) is written as a big-endian 32-bit value in the last four bytes.
function generateIv(sampleIndex: number): Uint8Array {
  const iv = new Uint8Array(16);
  const counter = sampleIndex + 1;
  iv[12] = (counter >>> 24) & 0xff;
  iv[13] = (counter >>> 16) & 0xff;
  iv[14] = (counter >>> 8) & 0xff;
  iv[15] = counter & 0xff;
  return iv;
}

// Builds a senc box (version=0, flags=0x000002) with one all-clear subsample per sample.
// Samples larger than 65535 bytes are split into multiple all-clear subsamples.
//
// Per-sample layout: IV(16) + subsample_count(2) + N×[BytesOfClear(2)+BytesOfProtected(4)]
function buildSencBox(sampleSizes: number[]): Uint8Array {
  const sampleCount = sampleSizes.length;

  // Pre-calculate per-sample subsample counts to size the box exactly once
  const subsampleCounts: number[] = [];
  let recordsSize = 0;
  for (let i = 0; i < sampleCount; i++) {
    const count = sampleSizes[i] === 0 ? 1 : Math.ceil(sampleSizes[i] / 65535);
    subsampleCounts.push(count);
    recordsSize += 16 + 2 + 6 * count; // IV + subsample_count + entries
  }

  // FullBox header(8) + version/flags(4) + sample_count(4) = 16 bytes overhead
  const totalSize = 16 + recordsSize;
  const senc = new Uint8Array(totalSize);

  writeUint32(senc, 0, totalSize);
  senc[4] = 0x73;
  senc[5] = 0x65;
  senc[6] = 0x6e;
  senc[7] = 0x63; // "senc"
  // version=0, flags=0x000002 (use-subsample-encryption)
  senc[8] = 0x00;
  senc[9] = 0x00;
  senc[10] = 0x00;
  senc[11] = 0x02;
  writeUint32(senc, 12, sampleCount);

  let pos = 16;
  for (let i = 0; i < sampleCount; i++) {
    senc.set(generateIv(i), pos);
    pos += 16;

    const subsampleCount = subsampleCounts[i];
    senc[pos] = (subsampleCount >>> 8) & 0xff;
    senc[pos + 1] = subsampleCount & 0xff;
    pos += 2;

    let remaining = sampleSizes[i];
    for (let j = 0; j < subsampleCount; j++) {
      const clearBytes = Math.min(remaining, 65535);
      remaining -= clearBytes;
      senc[pos] = (clearBytes >>> 8) & 0xff;
      senc[pos + 1] = clearBytes & 0xff;
      // BytesOfProtectedData = 0 (already zero from Uint8Array initialisation)
      pos += 6;
    }
  }

  return senc;
}

function validateSencBox(
  senc: Uint8Array,
  sampleSizes: number[],
  sampleCount: number,
): void {
  const tag = '[playready-workaround] senc validation:';

  if (senc[8] !== 0) {
    logger.warn(`${tag} version should be 0, got ${senc[8]}`);
  }

  const flags = (senc[9] << 16) | (senc[10] << 8) | senc[11];
  if (flags !== 0x000002) {
    logger.warn(
      `${tag} flags should be 0x000002, got 0x${flags.toString(16).padStart(6, '0')}`,
    );
  }

  const encSampleCount = readUint32(senc, 12);
  if (encSampleCount !== sampleCount) {
    logger.warn(
      `${tag} sample_count: expected ${sampleCount}, got ${encSampleCount}`,
    );
  }

  const seenIvs = new Set<string>();
  let pos = 16;
  for (let i = 0; i < sampleCount; i++) {
    const ivKey = Array.from(senc.subarray(pos, pos + 16)).join(',');
    if (seenIvs.has(ivKey)) {
      logger.warn(`${tag} duplicate IV at sample ${i}`);
    }
    seenIvs.add(ivKey);
    pos += 16;

    const subsampleCount = (senc[pos] << 8) | senc[pos + 1];
    pos += 2;

    if (subsampleCount < 1) {
      logger.warn(`${tag} sample ${i} has subsample_count < 1`);
    }

    let totalBytes = 0;
    for (let j = 0; j < subsampleCount; j++) {
      const clearBytes = (senc[pos] << 8) | senc[pos + 1];
      const protectedBytes = readUint32(senc, pos + 2);
      if (protectedBytes !== 0) {
        logger.warn(
          `${tag} sample ${i} subsample ${j} BytesOfProtectedData !== 0`,
        );
      }
      totalBytes += clearBytes + protectedBytes;
      pos += 6;
    }

    if (i < sampleSizes.length && totalBytes !== sampleSizes[i]) {
      logger.warn(
        `${tag} sample ${i} total bytes ${totalBytes} !== sample size ${sampleSizes[i]}`,
      );
    }
  }
}

// Builds an untyped saiz box (version=0, flags=0, no aux_info_type fields).
// Used in mirror-encrypted-aux-info mode to match the real encrypted segment structure.
//
// Untyped compact layout (17 bytes = 0x11):
//   size(4) + "saiz"(4) + version=0/flags=0(4) +
//   default_sample_info_size=24(1) + sample_count(4)
function buildUntypedSaizBox(sampleCount: number): Uint8Array {
  const box = new Uint8Array(17);
  writeUint32(box, 0, 17);
  box[4] = 0x73;
  box[5] = 0x61;
  box[6] = 0x69;
  box[7] = 0x7a; // "saiz"
  // version=0, flags=0 (bytes 8-11 already zero)
  box[12] = 0x18; // default_sample_info_size = 24 (16 IV + 2 subsample_count + 6 per-entry)
  writeUint32(box, 13, sampleCount);
  return box;
}

// Builds an untyped saio box (version=0, flags=0, no aux_info_type fields), single entry.
// Used in mirror-encrypted-aux-info mode to match the real encrypted segment structure.
//
// Untyped layout (20 bytes = 0x14):
//   size(4) + "saio"(4) + version=0/flags=0(4) +
//   entry_count=1(4) + offset[0](4)
function buildUntypedSaioBox(offset: number): Uint8Array {
  const box = new Uint8Array(20);
  writeUint32(box, 0, 20);
  box[4] = 0x73;
  box[5] = 0x61;
  box[6] = 0x69;
  box[7] = 0x6f; // "saio"
  // version=0, flags=0 (bytes 8-11 already zero)
  writeUint32(box, 12, 1); // entry_count
  writeUint32(box, 16, offset); // offset[0]
  return box;
}

// Builds a typed saiz (sample auxiliary information sizes) box.
// flags=0x000001 signals aux_info_type/aux_info_type_parameter are present.
// Uses compact form when all senc aux records have the same size
// (one subsample per sample = IV(16) + count(2) + entry(6) = 24 bytes).
// Falls back to a per-sample size array for samples spanning multiple subsamples.
//
// Typed compact layout (25 bytes):
//   size(4) + "saiz"(4) + version=0/flags=0x000001(4) +
//   aux_info_type="cenc"(4) + aux_info_type_parameter=0(4) +
//   default_sample_info_size(1) + sample_count(4)
function buildSaizBox(sampleSizes: number[]): Uint8Array {
  const sampleCount = sampleSizes.length;

  // Mirror the subsample logic in buildSencBox to derive per-sample aux record sizes.
  const auxSizes: number[] = [];
  let uniform = true;
  for (let i = 0; i < sampleCount; i++) {
    const n = sampleSizes[i] === 0 ? 1 : Math.ceil(sampleSizes[i] / 65535);
    const sz = 18 + 6 * n; // IV(16) + subsample_count(2) + n×[clear(2)+protected(4)]
    auxSizes.push(sz);
    if (i > 0 && sz !== auxSizes[0]) uniform = false;
  }

  if (uniform && auxSizes.length > 0) {
    // Typed compact form: 25 bytes
    const box = new Uint8Array(25);
    writeUint32(box, 0, 25);
    box[4] = 0x73;
    box[5] = 0x61;
    box[6] = 0x69;
    box[7] = 0x7a; // "saiz"
    // version=0, flags=0x000001
    box[8] = 0x00;
    box[9] = 0x00;
    box[10] = 0x00;
    box[11] = 0x01;
    box[12] = 0x63;
    box[13] = 0x65;
    box[14] = 0x6e;
    box[15] = 0x63; // aux_info_type = "cenc"
    // aux_info_type_parameter = 0 (bytes 16-19, already zero)
    box[20] = auxSizes[0]; // default_sample_info_size
    writeUint32(box, 21, sampleCount);
    return box;
  }

  // Typed per-sample form: 25+N bytes
  const totalSize = 25 + sampleCount;
  const box = new Uint8Array(totalSize);
  writeUint32(box, 0, totalSize);
  box[4] = 0x73;
  box[5] = 0x61;
  box[6] = 0x69;
  box[7] = 0x7a; // "saiz"
  // version=0, flags=0x000001
  box[8] = 0x00;
  box[9] = 0x00;
  box[10] = 0x00;
  box[11] = 0x01;
  box[12] = 0x63;
  box[13] = 0x65;
  box[14] = 0x6e;
  box[15] = 0x63; // aux_info_type = "cenc"
  // aux_info_type_parameter = 0 (bytes 16-19, already zero)
  // default_sample_info_size = 0 (byte 20, already zero — per-sample sizes follow)
  writeUint32(box, 21, sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    box[25 + i] = auxSizes[i];
  }
  return box;
}

// Builds a typed saio (sample auxiliary information offsets) box with version=0, a single entry.
// flags=0x000001 signals aux_info_type/aux_info_type_parameter are present.
// offset is either moof-relative or file-relative depending on saioOffsetMode in the caller.
//
// Typed layout (28 bytes):
//   size(4) + "saio"(4) + version=0/flags=0x000001(4) +
//   aux_info_type="cenc"(4) + aux_info_type_parameter=0(4) +
//   entry_count=1(4) + offset[0](4)
function buildSaioBox(offset: number): Uint8Array {
  const box = new Uint8Array(28);
  writeUint32(box, 0, 28);
  box[4] = 0x73;
  box[5] = 0x61;
  box[6] = 0x69;
  box[7] = 0x6f; // "saio"
  // version=0, flags=0x000001
  box[8] = 0x00;
  box[9] = 0x00;
  box[10] = 0x00;
  box[11] = 0x01;
  box[12] = 0x63;
  box[13] = 0x65;
  box[14] = 0x6e;
  box[15] = 0x63; // aux_info_type = "cenc"
  // aux_info_type_parameter = 0 (bytes 16-19, already zero)
  writeUint32(box, 20, 1); // entry_count
  writeUint32(box, 24, offset);
  return box;
}

// Validates that saiz, saio, and senc appear in the correct order inside traf,
// and that their metadata is self-consistent.
function validateSaizSaioSenc(
  patched: Uint8Array,
  expectedSampleCount: number,
  expectedSaioOffset: number,
  saioOffsetMode: 'moof-relative' | 'file-relative',
  clearPrerollCencMode:
    | 'sgpd-sbgp'
    | 'aux-info-only'
    | 'mirror-encrypted-aux-info'
    | 'mirror-encrypted-senc-shape',
  encryptedSencBox: Uint8Array | null = null,
): void {
  const tag = '[playready-workaround] saiz/saio/senc validation:';
  const useUntypedBoxes =
    clearPrerollCencMode === 'mirror-encrypted-aux-info' ||
    clearPrerollCencMode === 'mirror-encrypted-senc-shape';
  const mirrorMode = useUntypedBoxes; // alias kept for the branch logic below

  const moofArr = findBox(patched, ['moof']);
  if (!moofArr.length) {
    logger.warn(`${tag} moof not found`);
    return;
  }
  const trafArr = findBox(moofArr[0], ['traf']);
  if (!trafArr.length) {
    logger.warn(`${tag} traf not found`);
    return;
  }
  const traf = trafArr[0];

  const saizArr = findBox(traf, ['saiz']);
  const saioArr = findBox(traf, ['saio']);
  const sencArr = findBox(traf, ['senc']);

  if (!saizArr.length) logger.warn(`${tag} saiz not found in traf`);
  if (!saioArr.length) logger.warn(`${tag} saio not found in traf`);
  if (!sencArr.length) logger.warn(`${tag} senc not found in traf`);
  if (!saizArr.length || !saioArr.length || !sencArr.length) return;

  const saiz = saizArr[0];
  const saio = saioArr[0];
  const senc = sencArr[0];

  // Order: saiz → saio → senc (byteOffset is the content start = after the 8-byte header,
  // but relative ordering is preserved within the shared backing ArrayBuffer)
  if (saiz.byteOffset >= saio.byteOffset) {
    logger.warn(`${tag} saiz does not precede saio`);
  }
  if (saio.byteOffset >= senc.byteOffset) {
    logger.warn(`${tag} saio does not precede senc`);
  }

  // saiz validation — layout differs between typed (flags=0x000001) and untyped (flags=0)
  const saizSize = readUint32(patched, saiz.byteOffset - 8);
  const saizFlags = (saiz[1] << 16) | (saiz[2] << 8) | saiz[3];
  if (mirrorMode) {
    // Untyped saiz: version(1)/flags(3) | default_sample_info_size(1) | sample_count(4)
    const defaultSampleInfoSize = saiz[4];
    const saizSampleCount = readUint32(saiz, 5);
    if (saizSize !== 0x11) {
      logger.warn(
        `${tag} saiz.size: expected 0x11, got 0x${saizSize.toString(16)}`,
      );
    }
    if (saizFlags !== 0) {
      logger.warn(
        `${tag} saiz.flags: expected 0, got 0x${saizFlags.toString(16).padStart(6, '0')}`,
      );
    }
    if (defaultSampleInfoSize !== 24) {
      logger.warn(
        `${tag} saiz.default_sample_info_size: expected 24, got ${defaultSampleInfoSize}`,
      );
    }
    if (saizSampleCount !== expectedSampleCount) {
      logger.warn(
        `${tag} saiz.sample_count: expected ${expectedSampleCount}, got ${saizSampleCount}`,
      );
    }
  } else {
    // Typed saiz: version(1)/flags(3) | aux_info_type(4) | aux_info_type_parameter(4) |
    //             default_sample_info_size(1) | sample_count(4)
    const saizAuxType = bin2str(saiz.subarray(4, 8));
    const saizAuxParam = readUint32(saiz, 8);
    const defaultSampleInfoSize = saiz[12];
    const saizSampleCount = readUint32(saiz, 13);
    if (saizSize !== 0x19) {
      logger.warn(
        `${tag} saiz.size: expected 0x19, got 0x${saizSize.toString(16)}`,
      );
    }
    if (saizFlags !== 0x000001) {
      logger.warn(
        `${tag} saiz.flags: expected 0x000001, got 0x${saizFlags.toString(16).padStart(6, '0')}`,
      );
    }
    if (saizAuxType !== 'cenc') {
      logger.warn(
        `${tag} saiz.aux_info_type: expected "cenc", got "${saizAuxType}"`,
      );
    }
    if (saizAuxParam !== 0) {
      logger.warn(
        `${tag} saiz.aux_info_type_parameter: expected 0, got ${saizAuxParam}`,
      );
    }
    if (defaultSampleInfoSize !== 24) {
      logger.warn(
        `${tag} saiz.default_sample_info_size: expected 24, got ${defaultSampleInfoSize}`,
      );
    }
    if (saizSampleCount !== expectedSampleCount) {
      logger.warn(
        `${tag} saiz.sample_count: expected ${expectedSampleCount}, got ${saizSampleCount}`,
      );
    }
  }

  // saio validation — layout differs between typed (flags=0x000001) and untyped (flags=0)
  const saioSize = readUint32(patched, saio.byteOffset - 8);
  const saioFlags = (saio[1] << 16) | (saio[2] << 8) | saio[3];
  if (mirrorMode) {
    // Untyped saio: version(1)/flags(3) | entry_count(4) | offset[0](4)
    const entryCount = readUint32(saio, 4);
    const saioOffset = readUint32(saio, 8);
    if (saioSize !== 0x14) {
      logger.warn(
        `${tag} saio.size: expected 0x14, got 0x${saioSize.toString(16)}`,
      );
    }
    if (saioFlags !== 0) {
      logger.warn(
        `${tag} saio.flags: expected 0, got 0x${saioFlags.toString(16).padStart(6, '0')}`,
      );
    }
    if (entryCount !== 1) {
      logger.warn(`${tag} saio.entry_count: expected 1, got ${entryCount}`);
    }
    if (saioOffset !== expectedSaioOffset) {
      logger.warn(
        `${tag} saio.offset[0] (${saioOffsetMode}): expected 0x${expectedSaioOffset.toString(16).padStart(8, '0')}, got 0x${saioOffset.toString(16).padStart(8, '0')}`,
      );
    }
  } else {
    // Typed saio: version(1)/flags(3) | aux_info_type(4) | aux_info_type_parameter(4) |
    //             entry_count(4) | offset[0](4)
    const saioAuxType = bin2str(saio.subarray(4, 8));
    const saioAuxParam = readUint32(saio, 8);
    const entryCount = readUint32(saio, 12);
    const saioOffset = readUint32(saio, 16);
    if (saioSize !== 0x1c) {
      logger.warn(
        `${tag} saio.size: expected 0x1c, got 0x${saioSize.toString(16)}`,
      );
    }
    if (saioFlags !== 0x000001) {
      logger.warn(
        `${tag} saio.flags: expected 0x000001, got 0x${saioFlags.toString(16).padStart(6, '0')}`,
      );
    }
    if (saioAuxType !== 'cenc') {
      logger.warn(
        `${tag} saio.aux_info_type: expected "cenc", got "${saioAuxType}"`,
      );
    }
    if (saioAuxParam !== 0) {
      logger.warn(
        `${tag} saio.aux_info_type_parameter: expected 0, got ${saioAuxParam}`,
      );
    }
    if (entryCount !== 1) {
      logger.warn(`${tag} saio.entry_count: expected 1, got ${entryCount}`);
    }
    if (saioOffset !== expectedSaioOffset) {
      logger.warn(
        `${tag} saio.offset[0] (${saioOffsetMode}): expected 0x${expectedSaioOffset.toString(16).padStart(8, '0')}, got 0x${saioOffset.toString(16).padStart(8, '0')}`,
      );
    }
  }

  // senc content: version(1)/flags(3) | sample_count(4)
  const sencFlags = (senc[1] << 16) | (senc[2] << 8) | senc[3];
  const sencSampleCount = readUint32(senc, 4);
  if (sencSampleCount !== expectedSampleCount) {
    logger.warn(
      `${tag} senc.sample_count: expected ${expectedSampleCount}, got ${sencSampleCount}`,
    );
  }
  if (sencFlags !== 0x000002) {
    logger.warn(
      `${tag} senc.flags: expected 0x000002, got 0x${sencFlags.toString(16).padStart(6, '0')}`,
    );
  }

  // Byte-for-byte comparison against encrypted reference senc (mirror-encrypted-senc-shape only).
  // encryptedSencBox includes the 8-byte box header; the patched senc slice is read from patched[].
  if (encryptedSencBox) {
    const patchedSencStart = senc.byteOffset - 8;
    const patchedSencEnd = senc.byteOffset + senc.length;
    const patchedSencRaw = patched.subarray(patchedSencStart, patchedSencEnd);
    if (patchedSencRaw.length !== encryptedSencBox.length) {
      logger.warn(
        `${tag} senc size mismatch: expected 0x${encryptedSencBox.length.toString(16)}, got 0x${patchedSencRaw.length.toString(16)}`,
      );
    } else {
      let firstMismatch = -1;
      for (let i = 0; i < patchedSencRaw.length; i++) {
        if (patchedSencRaw[i] !== encryptedSencBox[i]) {
          firstMismatch = i;
          break;
        }
      }
      if (firstMismatch !== -1) {
        logger.warn(
          `${tag} senc payload differs from encrypted reference at byte offset 0x${firstMismatch.toString(16)}`,
        );
      } else {
        logger.debug(
          `${tag} senc payload matches encrypted reference byte-for-byte`,
        );
      }
    }
  }

  // In aux-info-only and mirror-encrypted-aux-info modes, sgpd(seig) and sbgp(seig) must be absent
  if (clearPrerollCencMode === 'aux-info-only' || mirrorMode) {
    const sgpdArr = findBox(traf, ['sgpd']);
    for (let i = 0; i < sgpdArr.length; i++) {
      if (bin2str(sgpdArr[i].subarray(4, 8)) === 'seig') {
        logger.warn(
          `${tag} sgpd(seig) found in traf (must be absent in ${clearPrerollCencMode} mode)`,
        );
      }
    }
    const sbgpSeigArr = findBox(traf, ['sbgp']);
    for (let i = 0; i < sbgpSeigArr.length; i++) {
      if (bin2str(sbgpSeigArr[i].subarray(4, 8)) === 'seig') {
        logger.warn(
          `${tag} sbgp(seig) found in traf (must be absent in ${clearPrerollCencMode} mode)`,
        );
      }
    }
  }
}

/**
 * sidx content layout (bytes within the box content, i.e. after the 8-byte header):
 *   0      : version (1 byte)
 *   1-3    : flags (3 bytes)
 *   4-7    : reference_ID
 *   8-11   : timescale
 *   v0: 12-15 earliest_presentation_time, 16-19 first_offset
 *   v1: 12-19 earliest_presentation_time, 20-27 first_offset
 *   v0: 20-21 reserved, 22-23 reference_count
 *   v1: 28-29 reserved, 30-31 reference_count
 *   v0: entries start at 24  (each entry = 12 bytes)
 *   v1: entries start at 32
 *
 * Each 12-byte reference entry:
 *   [0-3]  reference_type(1 bit) | referenced_size(31 bits)
 *   [4-7]  subsegment_duration
 *   [8-11] SAP flags
 */
function updateSidxReferencedSize(
  clearData: Uint8Array,
  newData: Uint8Array,
  insertedBytes: number,
  moofOffset: number,
): void {
  const sidxArr = findBox(clearData, ['sidx']);
  if (!sidxArr.length) return;

  const sidx = sidxArr[0];

  // Reject a sidx that starts at or after moof — it cannot reference the patched subsegment
  if (sidx.byteOffset - 8 >= moofOffset) {
    logger.warn(
      '[playready-workaround] sidx appears after moof, skipping update',
    );
    return;
  }

  const version = sidx[0];
  const refCountOffset = version === 0 ? 22 : 30;
  const entriesStart = version === 0 ? 24 : 32;

  const referenceCount = readUint16(sidx, refCountOffset);

  if (referenceCount === 0) {
    logger.warn(
      '[playready-workaround] sidx has 0 references, skipping update',
    );
    return;
  }

  if (referenceCount > 1) {
    // Cannot determine which reference covers the patched subsegment without
    // tracking byte ranges, so fail loudly rather than updating blindly.
    logger.warn(
      `[playready-workaround] sidx has ${referenceCount} references; cannot identify affected reference — sidx not updated`,
    );
    return;
  }

  // Single reference: it must cover the moof+mdat that follows sidx, so update it.
  // sidx.byteOffset is absolute within clearData; sidx is before insertionOffset so
  // its position is unchanged in newData.
  const refFieldOffset = sidx.byteOffset + entriesStart;
  const ref = readUint32(newData, refFieldOffset);
  const referenceType = ref & 0x80000000;
  const referencedSize = ref & 0x7fffffff;

  const newReferencedSize = referencedSize + insertedBytes;
  if (newReferencedSize > 0x7fffffff) {
    logger.warn(
      '[playready-workaround] sidx referenced_size would overflow 31 bits, skipping update',
    );
    return;
  }

  writeUint32(newData, refFieldOffset, referenceType | newReferencedSize);
}

function validatePatchedSegment(
  original: Uint8Array,
  patched: Uint8Array,
  insertedBytes: number,
  moofOffset: number,
  trafOffset: number,
  trunDataOffsetPos: number,
): void {
  const tag = '[playready-workaround] validation:';

  if (patched.length !== original.length + insertedBytes) {
    logger.warn(
      `${tag} file size: expected ${original.length + insertedBytes}, got ${patched.length}`,
    );
  }

  const origMoofSize = readUint32(original, moofOffset);
  const patchedMoofSize = readUint32(patched, moofOffset);
  if (patchedMoofSize !== origMoofSize + insertedBytes) {
    logger.warn(
      `${tag} moof.size: expected ${origMoofSize + insertedBytes}, got ${patchedMoofSize}`,
    );
  }

  const origTrafSize = readUint32(original, trafOffset);
  const patchedTrafSize = readUint32(patched, trafOffset);
  if (patchedTrafSize !== origTrafSize + insertedBytes) {
    logger.warn(
      `${tag} traf.size: expected ${origTrafSize + insertedBytes}, got ${patchedTrafSize}`,
    );
  }

  if (trunDataOffsetPos !== -1) {
    const origDataOffset = readUint32(original, trunDataOffsetPos);
    const patchedDataOffset = readUint32(patched, trunDataOffsetPos);
    if (patchedDataOffset !== origDataOffset + insertedBytes) {
      logger.warn(
        `${tag} trun.data_offset: expected ${origDataOffset + insertedBytes}, got ${patchedDataOffset}`,
      );
    }
  }

  // Verify mdat payload is byte-for-byte unchanged
  const origMdatArr = findBox(original, ['mdat']);
  const patchedMdatArr = findBox(patched, ['mdat']);
  if (!origMdatArr.length || !patchedMdatArr.length) {
    logger.warn(`${tag} mdat not found`);
  } else {
    const origMdat = origMdatArr[0];
    const patchedMdat = patchedMdatArr[0];

    if (patchedMdat.byteOffset !== origMdat.byteOffset + insertedBytes) {
      logger.warn(
        `${tag} mdat offset: expected ${origMdat.byteOffset + insertedBytes}, got ${patchedMdat.byteOffset}`,
      );
    }

    if (origMdat.length !== patchedMdat.length) {
      logger.warn(
        `${tag} mdat length changed: ${origMdat.length} → ${patchedMdat.length}`,
      );
    } else {
      // Spot-check first and last 8 bytes to avoid O(n) scan on large payloads
      const checkOffsets = [0, origMdat.length - 8];
      for (let ci = 0; ci < checkOffsets.length; ci++) {
        const checkOffset = checkOffsets[ci];
        if (checkOffset < 0) continue;
        for (let b = 0; b < 8; b++) {
          if (origMdat[checkOffset + b] !== patchedMdat[checkOffset + b]) {
            logger.warn(
              `${tag} mdat payload differs at offset ${checkOffset + b}`,
            );
            break;
          }
        }
      }
    }
  }

  // Verify sidx referenced_size bit-31 (reference_type) is unchanged
  const origSidxArr = findBox(original, ['sidx']);
  const patchedSidxArr = findBox(patched, ['sidx']);
  if (origSidxArr.length && patchedSidxArr.length) {
    const origSidx = origSidxArr[0];
    const patchedSidx = patchedSidxArr[0];
    const version = origSidx[0];
    const entriesStart = version === 0 ? 24 : 32;
    const origRefType = readUint32(origSidx, entriesStart) & 0x80000000;
    const patchedRefType = readUint32(patchedSidx, entriesStart) & 0x80000000;
    if (origRefType !== patchedRefType) {
      logger.warn(`${tag} sidx reference_type bit changed`);
    }
  }
}

export function patchClearInitSegment(
  clearInitSegmentData: Uint8Array,
  firstEncryptedInitSegmentData: Uint8Array,
): Uint8Array {
  dumpSegment(
    '$$$$ First clear init segment without PSSH boxes',
    clearInitSegmentData,
    'clear init',
  );
  dumpSegment(
    '$$$$ First encrypted init segment with PSSH boxes',
    firstEncryptedInitSegmentData,
    'encrypted init',
  );

  // Collect PSSH boxes from the encrypted init segment.
  const psshBoxes: Uint8Array[] = [];
  const encryptedMoovContent = findBox(firstEncryptedInitSegmentData, [
    'moov',
  ])[0];
  if (encryptedMoovContent) {
    let offset = 0;
    while (offset < encryptedMoovContent.length) {
      const size = readUint32(encryptedMoovContent, offset);
      if (size < 8) break;
      const type = bin2str(
        encryptedMoovContent.subarray(offset + 4, offset + 8),
      );
      if (type === 'pssh') {
        psshBoxes.push(encryptedMoovContent.subarray(offset, offset + size));
      }
      offset += size;
    }
  }
  if (psshBoxes.length === 0) {
    logger.debug('No PSSH boxes found in encrypted init segment');
    dumpSegment(
      '$$$$ Clear init segment unchanged (no PSSH found)',
      clearInitSegmentData,
      'patched init',
    );
    return clearInitSegmentData;
  }

  // Extract the sinf box from the encrypted init's encv sample entry.
  // We inject this sinf into the clear init's avc1 entry (renamed to encv)
  // so Chrome sets up an encrypted decode pipeline. We preserve the clear
  // init's own avcC/codec params — replacing the whole stsd would break
  // every level other than the one the encrypted init was packaged for.
  const encryptedStsdContent = findBox(firstEncryptedInitSegmentData, [
    'moov',
    'trak',
    'mdia',
    'minf',
    'stbl',
    'stsd',
  ])[0];
  if (!encryptedStsdContent) {
    logger.warn(
      '[playready-workaround] Could not find encrypted stsd, falling back to PSSH-only patch',
    );
    return patchPsshOnly(clearInitSegmentData, psshBoxes);
  }
  const encryptedSampleEntries = encryptedStsdContent.subarray(8);
  const encv = findBox(encryptedSampleEntries, ['encv'])[0];
  if (!encv) {
    logger.warn(
      '[playready-workaround] Could not find encv, falling back to PSSH-only patch',
    );
    return patchPsshOnly(clearInitSegmentData, psshBoxes);
  }
  // Skip the 78-byte VisualSampleEntry fixed fields to reach child boxes.
  const encvChildren = encv.subarray(78);
  const sinfContent = findBox(encvChildren, ['sinf'])[0];
  if (!sinfContent) {
    logger.warn(
      '[playready-workaround] Could not find sinf, falling back to PSSH-only patch',
    );
    return patchPsshOnly(clearInitSegmentData, psshBoxes);
  }
  // Copy sinf (with its 8-byte header) so we can mutate default_isProtected.
  // Layout: sinf(8) + frma(12) + schm(20) + schi(8) + tenc(8) + tenc_content(24).
  // default_isProtected is at byte 62 of the full box (offset 54 within tenc content).
  const sinfBox = firstEncryptedInitSegmentData.slice(
    sinfContent.byteOffset - 8,
    sinfContent.byteOffset + sinfContent.length,
  );
  sinfBox[62] = 1; // default_IsProtected = 1
  sinfBox[63] = 16; // default_Per_Sample_IV_Size = 16

  // Find the clear stsd and ancestor boxes.
  const clearStsdContent = findBox(clearInitSegmentData, [
    'moov',
    'trak',
    'mdia',
    'minf',
    'stbl',
    'stsd',
  ])[0];
  const clearMoov = findBox(clearInitSegmentData, ['moov'])[0];
  const clearTrak = findBox(clearInitSegmentData, ['moov', 'trak'])[0];
  const clearMdia = findBox(clearInitSegmentData, ['moov', 'trak', 'mdia'])[0];
  const clearMinf = findBox(clearInitSegmentData, [
    'moov',
    'trak',
    'mdia',
    'minf',
  ])[0];
  const clearStbl = findBox(clearInitSegmentData, [
    'moov',
    'trak',
    'mdia',
    'minf',
    'stbl',
  ])[0];

  if (
    !clearStsdContent ||
    !clearMoov ||
    !clearTrak ||
    !clearMdia ||
    !clearMinf ||
    !clearStbl
  ) {
    logger.warn(
      '[playready-workaround] Could not find clear stsd or parent boxes, falling back to PSSH-only patch',
    );
    return patchPsshOnly(clearInitSegmentData, psshBoxes);
  }

  // Guard: bail out if the sample entry is already encv — patch was already applied and a second
  // sinf insertion would produce two consecutive sinf boxes inside the encv sample entry.
  const clearStsdBoxStart = clearStsdContent.byteOffset - 8;
  const entryTypeOffset = clearStsdBoxStart + 20;
  if (
    bin2str(
      clearInitSegmentData.subarray(entryTypeOffset, entryTypeOffset + 4),
    ) === 'encv'
  ) {
    logger.debug(
      '[playready-workaround] patchClearInitSegment: encv already present, skipping re-patch',
    );
    return clearInitSegmentData;
  }

  const sinfSize = sinfBox.length;
  const psshTotal = psshBoxes.reduce((acc, b) => acc + b.length, 0);
  // clearStsdBoxEnd = first byte after the stsd box = also end of the sole
  // sample entry, so appending sinfBox here extends that entry.
  const clearStsdBoxEnd = clearStsdContent.byteOffset + clearStsdContent.length;
  const moovBoxOffset = clearMoov.byteOffset - 8;
  const moovBoxEnd = moovBoxOffset + clearMoov.length + 8;

  const result = new Uint8Array(
    clearInitSegmentData.length + sinfSize + psshTotal,
  );

  // 1. Copy everything up to and including the stsd box content unchanged.
  result.set(clearInitSegmentData.subarray(0, clearStsdBoxEnd), 0);

  // 2. Insert sinf immediately after stsd content (inside the sample entry —
  //    sizes updated below make the parser treat it as a child of encv).
  result.set(sinfBox, clearStsdBoxEnd);

  // 3. Copy from after stsd to end of moov.
  result.set(
    clearInitSegmentData.subarray(clearStsdBoxEnd, moovBoxEnd),
    clearStsdBoxEnd + sinfSize,
  );

  // 4. Append PSSH boxes at the end of moov.
  let psshDest = clearStsdBoxEnd + sinfSize + (moovBoxEnd - clearStsdBoxEnd);
  for (let i = 0; i < psshBoxes.length; i++) {
    result.set(psshBoxes[i], psshDest);
    psshDest += psshBoxes[i].length;
  }

  // 5. Copy any bytes after moov.
  result.set(clearInitSegmentData.subarray(moovBoxEnd), psshDest);

  // 6. Rename the avc1 sample entry type to encv.
  //    stsd box header = 8, FullBox version+flags+count = 8, entry size = 4,
  //    so entry type sits at clearStsdBoxStart + 20 (both vars hoisted to the guard above).
  result[entryTypeOffset] = 0x65; // 'e'
  result[entryTypeOffset + 1] = 0x6e; // 'n'
  result[entryTypeOffset + 2] = 0x63; // 'c'
  result[entryTypeOffset + 3] = 0x76; // 'v'

  // 7. Update box sizes.
  // Sample entry (avc1→encv) grows by sinfSize.
  const entryOffset = clearStsdBoxStart + 16;
  writeUint32(result, entryOffset, readUint32(result, entryOffset) + sinfSize);
  // Ancestors all start before the insertion point so their offsets are
  // unchanged from clearInitSegmentData.
  writeUint32(
    result,
    clearStsdBoxStart,
    clearStsdContent.length + 8 + sinfSize,
  );
  writeUint32(
    result,
    clearStbl.byteOffset - 8,
    clearStbl.length + 8 + sinfSize,
  );
  writeUint32(
    result,
    clearMinf.byteOffset - 8,
    clearMinf.length + 8 + sinfSize,
  );
  writeUint32(
    result,
    clearMdia.byteOffset - 8,
    clearMdia.length + 8 + sinfSize,
  );
  writeUint32(
    result,
    clearTrak.byteOffset - 8,
    clearTrak.length + 8 + sinfSize,
  );
  writeUint32(
    result,
    moovBoxOffset,
    clearMoov.length + 8 + sinfSize + psshTotal,
  );

  dumpSegment(
    '$$$$ Clear init segment: avc1→encv+sinf (isProtected=0) + PSSH injected',
    result,
    'patched init',
  );
  return result;
}

function patchPsshOnly(
  clearInitSegmentData: Uint8Array,
  psshBoxes: Uint8Array[],
): Uint8Array {
  const moovInClear = findBox(clearInitSegmentData, ['moov'])[0];
  if (!moovInClear) {
    return clearInitSegmentData;
  }
  const moovBoxOffset = moovInClear.byteOffset - 8;
  const moovBoxSize = moovInClear.length + 8;
  const psshTotal = psshBoxes.reduce((acc, b) => acc + b.length, 0);
  const newMoovBoxSize = moovBoxSize + psshTotal;
  const result = new Uint8Array(clearInitSegmentData.length + psshTotal);
  result.set(clearInitSegmentData.subarray(0, moovBoxOffset), 0);
  writeUint32(result, moovBoxOffset, newMoovBoxSize);
  result.set(
    clearInitSegmentData.subarray(
      moovBoxOffset + 4,
      moovBoxOffset + moovBoxSize,
    ),
    moovBoxOffset + 4,
  );
  let psshDest = moovBoxOffset + moovBoxSize;
  for (let i = 0; i < psshBoxes.length; i++) {
    result.set(psshBoxes[i], psshDest);
    psshDest += psshBoxes[i].length;
  }
  result.set(
    clearInitSegmentData.subarray(moovBoxOffset + moovBoxSize),
    moovBoxOffset + newMoovBoxSize,
  );
  return result;
}

const FIRST_ENCRYPTED_MEDIA_SEGMENT_URL =
  'https://sample-videos-zyrkp2nj.s3-eu-west-1.amazonaws.com/big-buck-bunny-clear-to-encrypted/hls_fmp4_cenc_pw/video_348000/encrypted/1.m4s';

export function preLoadFirstEncryptedMediaSegmentData(): Promise<Uint8Array> {
  return fetch(FIRST_ENCRYPTED_MEDIA_SEGMENT_URL)
    .then((response) => {
      if (!response.ok) {
        throw new Error(
          `Failed to fetch first encrypted media segment: ${response.statusText}`,
        );
      }
      return response.arrayBuffer();
    })
    .then((arrayBuffer) => {
      const data = new Uint8Array(arrayBuffer);
      dumpSegment(
        '$$$$ first encrypted media segment',
        data,
        'encrypted media',
      );
      return data;
    });
}

export function preLoadFirstEncryptedInitSegmentData(
  firstEncryptedInitSegment: Fragment,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (firstEncryptedInitSegment.data) {
      resolve(firstEncryptedInitSegment.data as Uint8Array);
      return;
    }
    // remove the resource filename from the base URL to get the directory
    const urlBase = firstEncryptedInitSegment.base.url.replace(/\/[^/]*$/, '/');
    const initSegmentUrl = urlBase + firstEncryptedInitSegment.relurl;
    fetch(initSegmentUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `Failed to fetch init segment data from ${initSegmentUrl}: ${response.statusText}`,
          );
        }
        return response.arrayBuffer();
      })
      .then((arrayBuffer) => resolve(new Uint8Array(arrayBuffer)))
      .catch(reject);
  });
}
