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
  _firstEncryptedSegmentData: Uint8Array,
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
  // trun content layout: version(1) + flags(3) + sample_count(4) + [data_offset(4)] + ...
  const sampleCount = readUint32(trun, 4);
  // data_offset_present is flag bit 0x000001; flags are big-endian in bytes 1-3,
  // so trun[3] is the least-significant byte
  const dataOffsetPresent = trun[3] & 0x01;

  // Find existing sbgp boxes: preserve roll, abort if seig already present
  const sbgpArr = findBox(traf, ['sbgp']);
  let insertionOffset = -1;
  for (let i = 0; i < sbgpArr.length; i++) {
    const sbgp = sbgpArr[i];
    // sbgp content: version/flags(4) + grouping_type(4) + ...
    const groupingType = bin2str(sbgp.subarray(4, 8));
    if (groupingType === 'seig') {
      logger.debug(
        '[playready-workaround] patchClearMediaSegment: seig already present, skipping',
      );
      return clearSegmentData;
    }
    if (groupingType === 'roll') {
      // Insert after the end of this roll sbgp box (byteOffset is absolute in clearData)
      insertionOffset = sbgp.byteOffset + sbgp.length;
    }
  }

  // Fallback: insert after trun if no roll sbgp found
  if (insertionOffset === -1) {
    insertionOffset = trun.byteOffset + trun.length;
  }

  const INSERTED_BYTES = 72; // 44 (sgpd) + 28 (sbgp)

  // Build sgpd(seig) — 44 bytes
  // Layout: size(4) + "sgpd"(4) + version=1/flags=0(4) + grouping_type="seig"(4) +
  //         default_length=20(4) + entry_count=1(4) + entry(20)
  // Entry: isProtected=0(3) + perSampleIvSize=0(1) + zero-KID(16) — all zero
  const sgpdSeig = new Uint8Array(44);
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

  // Build sbgp(seig) — 28 bytes
  // Layout: size(4) + "sbgp"(4) + version=0/flags=0(4) + grouping_type="seig"(4) +
  //         entry_count=1(4) + sample_count(4) + group_description_index=1(4)
  const sbgpSeig = new Uint8Array(28);
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

  // Assemble patched segment
  const newData = new Uint8Array(clearSegmentData.length + INSERTED_BYTES);
  newData.set(clearSegmentData.subarray(0, insertionOffset), 0);
  newData.set(sgpdSeig, insertionOffset);
  newData.set(sbgpSeig, insertionOffset + 44);
  newData.set(
    clearSegmentData.subarray(insertionOffset),
    insertionOffset + INSERTED_BYTES,
  );

  // Update moof.size and traf.size — both box headers are before insertionOffset
  // so their positions in newData are unchanged
  const moofSizeOffset = moof.byteOffset - 8;
  writeUint32(
    newData,
    moofSizeOffset,
    readUint32(newData, moofSizeOffset) + INSERTED_BYTES,
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
    moofSizeOffset,
  );

  validatePatchedSegment(
    clearSegmentData,
    newData,
    INSERTED_BYTES,
    moofSizeOffset,
    trafSizeOffset,
    dataOffsetPresent ? trun.byteOffset + 8 : -1,
  );

  dumpSegment(
    '$$$$ Clear media segment after CENC sample-group patch',
    newData,
    'patched media',
  );
  return newData;
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
  //    so entry type sits at clearStsdBoxStart + 20.
  const clearStsdBoxStart = clearStsdContent.byteOffset - 8;
  const entryTypeOffset = clearStsdBoxStart + 20;
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

export function preLoadFirstEncryptedInitSegmentData(
  firstEncryptedInitSegment: Fragment,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (firstEncryptedInitSegment.data) {
      resolve(firstEncryptedInitSegment.data as Uint8Array);
    }
    // remove the resource file from the base URL to get the true base URL for the init segment
    // e.g. https://sample-videos-zyrkp2nj.s3-eu-west-1.amazon…ncrypted/hls_fmp4_cenc_pw/video_348000/index.m3u
    const urlBase = firstEncryptedInitSegment.base.url.replace(/\/[^/]*$/, '/');
    const initSegmentUrl = urlBase + firstEncryptedInitSegment.relurl;
    fetch(initSegmentUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `Failed to fetch init segment data from ${initSegmentUrl}: ${response.statusText}`,
          );
        }
        response
          .arrayBuffer()
          .then((arrayBuffer) => {
            resolve(new Uint8Array(arrayBuffer));
          })
          .catch((error) => {
            reject(error);
          });
      })
      .catch((error) => {
        reject(error);
      });
  });
}
