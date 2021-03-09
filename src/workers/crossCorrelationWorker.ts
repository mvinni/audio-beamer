import type crossCorrelate from './crossCorrelation';

/* eslint import/no-webpack-loader-syntax: off */
import CrossCorrelationWorker from 'comlink-loader?singleton=true!./crossCorrelation';

export type CrossCorrelationType = typeof crossCorrelate;
type Unpromise<T extends Promise<any>> = T extends Promise<infer U> ? U : never;
export type CrossCorrelationOutputType = Unpromise<ReturnType<CrossCorrelationType>>;
// make typescript happy about the type
export default CrossCorrelationWorker as unknown as CrossCorrelationType;
