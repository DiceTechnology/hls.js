import { LevelDetails } from '../loader/level-details';
import { ErrorDetails } from '../errors';
import { Events } from '../events';
import type {
  ErrorData,
  LevelUpdatedData,
  MediaAttachingData,
} from '../types/events';
import { logger } from '../utils/logger';
import type { ComponentAPI } from '../types/component-api';
import type Hls from '../hls';
import type { HlsConfig } from '../config';

export default class LatencyController implements ComponentAPI {
  private hls: Hls;
  private readonly config: HlsConfig;
  private media: HTMLMediaElement | null = null;
  private levelDetails: LevelDetails | null = null;
  private currentTime: number = 0;
  private stallCount: number = 0;
  private _latency: number | null = null;
  private _lastStallTime: number = 0;
  private timeupdateHandler = () => this.timeupdate();

  constructor(hls: Hls) {
    this.hls = hls;
    this.config = hls.config;
    this.registerListeners();
  }

  get latency(): number {
    return this._latency || 0;
  }

  get maxLatency(): number {
    const { config, levelDetails } = this;
    if (config.liveMaxLatencyDuration !== undefined) {
      return config.liveMaxLatencyDuration;
    }
    return levelDetails
      ? config.liveMaxLatencyDurationCount * levelDetails.targetduration
      : 0;
  }

  get targetLatency(): number | null {
    const { levelDetails } = this;
    if (levelDetails === null) {
      return null;
    }
    const { holdBack, partHoldBack, targetduration } = levelDetails;
    const { liveSyncDuration, liveSyncDurationCount, lowLatencyMode } =
      this.config;
    const userConfig = this.hls.userConfig;
    let targetLatency = lowLatencyMode ? partHoldBack || holdBack : holdBack;
    if (
      userConfig.liveSyncDuration ||
      userConfig.liveSyncDurationCount ||
      targetLatency === 0
    ) {
      targetLatency =
        liveSyncDuration !== undefined
          ? liveSyncDuration
          : liveSyncDurationCount * targetduration;
    }
    const maxLiveSyncOnStallIncrease = targetduration;
    const liveSyncOnStallIncrease = 1.0;

    // try to recover
    const { recoverFromStallPeriod, minSmoothPlaybackBuffer } = this.config;
    if (
      lowLatencyMode &&
      this.stallCount > 0 &&
      Date.now() - this._lastStallTime > recoverFromStallPeriod && // no buffering in certain period
      this.forwardBufferLength > minSmoothPlaybackBuffer
    ) {
      // have enough data
      this._lastStallTime = Date.now();
      const maxStallCount = Math.floor(
        maxLiveSyncOnStallIncrease / liveSyncOnStallIncrease
      );
      if (this.stallCount > maxStallCount) {
        this.stallCount = maxStallCount;
      }
      this.stallCount--;
      logger.warn(
        '[playback-rate-controller]: Recover from stall, adjusting target latency'
      );
    }

    return (
      targetLatency +
      Math.min(
        this.stallCount * liveSyncOnStallIncrease,
        maxLiveSyncOnStallIncrease
      )
    );
  }

  get liveSyncPosition(): number | null {
    const liveEdge = this.estimateLiveEdge();
    const targetLatency = this.targetLatency;
    const levelDetails = this.levelDetails;
    if (liveEdge === null || targetLatency === null || levelDetails === null) {
      return null;
    }
    const edge = levelDetails.edge;
    const syncPosition = liveEdge - targetLatency - this.edgeStalled;
    const min = edge - levelDetails.totalduration;
    const max =
      edge -
      ((this.config.lowLatencyMode && levelDetails.partTarget) ||
        levelDetails.targetduration);
    return Math.min(Math.max(min, syncPosition), max);
  }

  get drift(): number {
    const { levelDetails } = this;
    if (levelDetails === null) {
      return 1;
    }
    return levelDetails.drift;
  }

  get edgeStalled(): number {
    const { levelDetails } = this;
    if (levelDetails === null) {
      return 0;
    }
    const maxLevelUpdateAge =
      ((this.config.lowLatencyMode && levelDetails.partTarget) ||
        levelDetails.targetduration) * 3;
    return Math.max(levelDetails.age - maxLevelUpdateAge, 0);
  }

  private get forwardBufferLength(): number {
    const { media, levelDetails } = this;
    if (!media || !levelDetails) {
      return 0;
    }
    const bufferedRanges = media.buffered.length;
    return (
      (bufferedRanges
        ? media.buffered.end(bufferedRanges - 1)
        : levelDetails.edge) - this.currentTime
    );
  }

  public destroy(): void {
    this.unregisterListeners();
    this.onMediaDetaching();
    this.levelDetails = null;
    // @ts-ignore
    this.hls = this.timeupdateHandler = null;
  }

  private registerListeners() {
    this.hls.on(Events.MEDIA_ATTACHED, this.onMediaAttached, this);
    this.hls.on(Events.MEDIA_DETACHING, this.onMediaDetaching, this);
    this.hls.on(Events.MANIFEST_LOADING, this.onManifestLoading, this);
    this.hls.on(Events.LEVEL_UPDATED, this.onLevelUpdated, this);
    this.hls.on(Events.ERROR, this.onError, this);
  }

  private unregisterListeners() {
    this.hls.off(Events.MEDIA_ATTACHED, this.onMediaAttached);
    this.hls.off(Events.MEDIA_DETACHING, this.onMediaDetaching);
    this.hls.off(Events.MANIFEST_LOADING, this.onManifestLoading);
    this.hls.off(Events.LEVEL_UPDATED, this.onLevelUpdated);
    this.hls.off(Events.ERROR, this.onError);
  }

  private onMediaAttached(
    event: Events.MEDIA_ATTACHED,
    data: MediaAttachingData
  ) {
    this.media = data.media;
    this.media.addEventListener('timeupdate', this.timeupdateHandler);
  }

  private onMediaDetaching() {
    if (this.media) {
      this.media.removeEventListener('timeupdate', this.timeupdateHandler);
      this.media = null;
    }
  }

  private onManifestLoading() {
    this.levelDetails = null;
    this._latency = null;
    this.stallCount = 0;
    this._lastStallTime = 0;
  }

  private onLevelUpdated(
    event: Events.LEVEL_UPDATED,
    { details }: LevelUpdatedData
  ) {
    this.levelDetails = details;
    if (details.advanced) {
      this.timeupdate();
    }
    if (!details.live && this.media) {
      this.media.removeEventListener('timeupdate', this.timeupdateHandler);
    }
  }

  private onError(event: Events.ERROR, data: ErrorData) {
    if (data.details !== ErrorDetails.BUFFER_STALLED_ERROR) {
      return;
    }
    this.stallCount++;
    this._lastStallTime = Date.now();

    logger.warn(
      '[playback-rate-controller]: Stall detected, adjusting target latency'
    );
  }

  private timeupdate() {
    const { media, levelDetails } = this;
    if (!media || !levelDetails) {
      return;
    }
    this.currentTime = media.currentTime;

    const latency = this.computeLatency();
    if (latency === null) {
      return;
    }
    this._latency = latency;

    // Adapt playbackRate to meet target latency in low-latency mode
    const {
      enableCatchupLoLP,
      lowLatencyMode,
      maxLiveSyncPlaybackRate,
      minSmoothPlaybackBuffer,
    } = this.config;
    if (!lowLatencyMode || maxLiveSyncPlaybackRate === 1) {
      return;
    }
    const targetLatency = this.targetLatency;
    if (targetLatency === null) {
      return;
    }
    // Only adjust playbackRate on browsers for now
    if (this.canDeviceChangePlaybackRate()) {
      const newRate = enableCatchupLoLP
        ? this.calculateNewPlaybackRateLolP(media, latency, targetLatency)
        : this.calculateNewPlaybackRateDefault(
            media,
            latency,
            targetLatency,
            levelDetails
          );
      if (newRate) {
        media.playbackRate = newRate;
      }
    }

    // seek to live edge
    const distanceFromTarget = latency - targetLatency;
    const liveMinLatencyDuration = Math.min(
      this.maxLatency,
      targetLatency + levelDetails.targetduration
    );
    if (
      levelDetails.live &&
      this.stallCount === 0 &&
      this.forwardBufferLength > minSmoothPlaybackBuffer &&
      distanceFromTarget > liveMinLatencyDuration &&
      this.liveSyncPosition
    ) {
      // alway seek to live sync position when current position is larger enough
      media.currentTime = this.liveSyncPosition;
    }
  }

  private estimateLiveEdge(): number | null {
    const { levelDetails } = this;
    if (levelDetails === null) {
      return null;
    }
    return levelDetails.edge + levelDetails.age;
  }

  private computeLatency(): number | null {
    const liveEdge = this.estimateLiveEdge();
    if (liveEdge === null) {
      return null;
    }
    return liveEdge - this.currentTime;
  }

  private canDeviceChangePlaybackRate(): boolean {
    const ua =
      typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
    // According to https://bugs.webkit.org/show_bug.cgi?id=208142
    // changing playbackRate in Safari can cause video playback disruption.
    const isSafari = /safari/.test(ua) && !/chrome/.test(ua);
    // Changing playbackRate in some devices also cause video playback disruption.
    const isDeviceNotSupported = ['xbox', 'web0s', 'tizen'].reduce(
      (result: boolean, deviceUA: string) => {
        return result || ua.indexOf(deviceUA) !== -1;
      },
      isSafari
    );
    return !isDeviceNotSupported;
  }

  private calculateNewPlaybackRateDefault(
    media: HTMLMediaElement,
    latency: number,
    targetLatency: number,
    levelDetails: LevelDetails
  ) {
    const distanceFromTarget = latency - targetLatency;
    // Only adjust playbackRate when within one target duration of targetLatency
    // and more than one second from under-buffering.
    // Playback further than one target duration from target can be considered DVR playback.
    const liveMinLatencyDuration = Math.min(
      this.maxLatency,
      targetLatency + levelDetails.targetduration
    );
    let newRate;
    const inLiveRange = distanceFromTarget < liveMinLatencyDuration;
    if (
      levelDetails.live &&
      inLiveRange &&
      distanceFromTarget > 0.05 &&
      this.forwardBufferLength > 1 &&
      this.canDeviceChangePlaybackRate() // Only adjust playbackRate on browsers for now
    ) {
      const { maxLiveSyncPlaybackRate } = this.config;
      const max = Math.min(2, Math.max(1.0, maxLiveSyncPlaybackRate));
      const rate =
        Math.round(
          (2 / (1 + Math.exp(-0.75 * distanceFromTarget - this.edgeStalled))) *
            20
        ) / 20;
      newRate = Math.min(max, Math.max(1, rate));
    } else if (media.playbackRate !== 1 && media.playbackRate !== 0) {
      newRate = 1;
    }
    return newRate;
  }

  private calculateNewPlaybackRateLolP(
    media: HTMLMediaElement,
    latency: number,
    targetLatency: number
  ) {
    const { minSmoothPlaybackBuffer, maxLiveSyncPlaybackRate } = this.config;

    const cpr = maxLiveSyncPlaybackRate - 1;
    let newRate;

    const bufferLevel = this.forwardBufferLength;
    // Hybrid: Buffer-based
    if (bufferLevel < minSmoothPlaybackBuffer) {
      // Buffer in danger, slow down
      const deltaBuffer = bufferLevel - minSmoothPlaybackBuffer; // -ve value
      const d = deltaBuffer * 5;

      // Playback rate must be between (1 - cpr) - (1 + cpr)
      // ex: if cpr is 0.5, it can have values between 0.5 - 1.5
      const s = (cpr * 2) / (1 + Math.pow(Math.E, -d));
      newRate = 1 - cpr + s;
    } else {
      // Hybrid: Latency-based
      // Buffer is safe, vary playback rate based on latency

      // Check if latency is within range of target latency
      const minDifference = 0.1;
      if (Math.abs(latency - targetLatency) <= minDifference * targetLatency) {
        newRate = 1;
      } else {
        const deltaLatency = latency - targetLatency;
        const d = deltaLatency * 5;

        // Playback rate must be between (1 - cpr) - (1 + cpr)
        // ex: if cpr is 0.5, it can have values between 0.5 - 1.5
        const s = (cpr * 2) / (1 + Math.pow(Math.E, -d));
        newRate = 1 - cpr + s;
      }
    }

    // don't change playbackrate for small variations (don't overload element with playbackrate changes)
    const minPlaybackRateChange = 0.02;
    if (Math.abs(media.playbackRate - newRate) <= minPlaybackRateChange) {
      newRate = null;
    }

    return newRate;
  }
}
