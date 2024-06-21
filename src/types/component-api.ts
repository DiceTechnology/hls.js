import EwmaBandWidthEstimator from '../utils/ewma-bandwidth-estimator';

export interface ComponentAPI {
  destroy(): void;
}

export interface AbrComponentAPI extends ComponentAPI {
  firstAutoLevel: number;
  forcedAutoLevel: number;
  nextAutoLevel: number;
  readonly bwEstimator?: EwmaBandWidthEstimator;
  resetEstimator(abrEwmaDefaultEstimate: number);
}

export interface NetworkComponentAPI extends ComponentAPI {
  startLoad(startPosition: number): void;
  stopLoad(): void;
}
