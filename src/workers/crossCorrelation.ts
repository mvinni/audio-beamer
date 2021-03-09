/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * This file (and this file only) is originally based on
 * https://github.com/adblockradio/xcorr, but has been
 * heavily modified.
 */

import * as DSP from 'dsp.js';
import { transfer as comlinkTransfer } from 'comlink';

type CorrelationInputArray = ArrayLike<number>; // Uint8Array | Uint16Array | number[];

var fftCache = null as null | {
  n: number,
  fft1: any,
  fft2: any,
};

/**
 * Cross-correlation between two time-domain audio signals in typed
 * arrays (for example Uint8Arrays or Float32Arrays).
 *
 * const analyser = audioCtx.createAnalyser();
 * analyser.fftSize = 4096; //2048;
 * const dataArray = new Uint8Array(bufferLength);
 * analyser.getByteTimeDomainData(dataArray);
 *
 *
 * Returns: {
 *   xcorr: an array of the correlation values,
 *   xcorrMax: the largest value in xcorr,
 *   iMax: the index of the largest value in the range [-n/2, n/2[,
 *   accPeak: iMax with sub-integer precision
 * }
 *
 * Contains portions from https://github.com/adblockradio/xcorr/blob/master/xcorr.js
 * Their LICENSE: Mozilla Public License 2.0
 */
export default async function correlateSignals(
      xsignal1: CorrelationInputArray,
      xsignal2: CorrelationInputArray,
      padWithZeros = true,
    ) {

  function wrapArray(array: CorrelationInputArray, padLength: number): ArrayLike<number> {
    return new Proxy<ArrayLike<number>>(array, {
      get: function(arr, prop) {
        if (prop === 'length') {
          return padLength;
        }

        if (typeof prop === 'string' || typeof prop === 'number') {
          const p = +prop;
          const isNum = (p === parseInt(prop));
          if (isNum && p >= arr.length && p < padLength) {
            return 0;
          }
        }
        // @ts-ignore
        return arr[prop];
      }
    });
  }

  let s1, s2;
  if (padWithZeros) {
    const forceLength = 2 * Math.max(xsignal1.length, xsignal2.length);
    s1 = wrapArray(xsignal1, forceLength);
    s2 = wrapArray(xsignal2, forceLength);
  } else {
    s1 = xsignal1;
    s2 = xsignal2;
  }

  const n = s1.length;

  if (fftCache === null || fftCache.n !== n) {
    // the sample rate used here doesn't matter (forward->inverse)
    fftCache = {
      n: n,
      fft1: new DSP.FFT(n, 44100),
      fft2: new DSP.FFT(n, 44100),
    };
  }

  const rms1 = DSP.DSP.RMS(xsignal1);
  const fft1 = fftCache.fft1;
  fft1.forward(s1);

  const rms2 = DSP.DSP.RMS(xsignal2);
  const fft2 = fftCache.fft2;
  fft2.forward(s2);

	const realp = new Array(n).fill(0).map((_, i) =>
        fft1.real[i] * fft2.real[i] + fft1.imag[i] * fft2.imag[i]);
	const imagp = new Array(n).fill(0).map((_, i) =>
        -fft1.real[i] * fft2.imag[i] + fft2.real[i] * fft1.imag[i]);
  // note we have taken the complex conjugate of fft2.

  const fftp = fft1; // re-use either one

  // rms1/rms2 can be zero, leading to Infinity (which is okish)
  const normalizer = 1./(rms1 || 0.000001)/(rms2 || 0.000001)/n;
  // normalize the module of xcorr to [-1, 1]
  const xcorr: Float64Array = fftp.inverse(realp, imagp).map(
    (coef: number) => coef * normalizer);

  // index of the max amplitude of xcorr
  const iMax = xcorr.reduce((indexTemporaryMax, testCoef, indexTestCoef) => {
    return Math.abs(testCoef) > Math.abs(xcorr[indexTemporaryMax]) ?
      indexTestCoef : indexTemporaryMax
  }, 0);

  const interpolated = interpolatePeak(
    iMax > 0 ? xcorr[iMax - 1] : xcorr[xcorr.length - 1],
    xcorr[iMax],
    iMax < xcorr.length - 1 ? xcorr[iMax + 1] : xcorr[0]);

  const wrapped = iMax < n / 2 ? iMax : iMax - n; // have iMax relative to index 0;

  return {
    xcorr: comlinkTransfer(xcorr, [xcorr.buffer]) as number[],
    xcorrMax: xcorr[iMax],
    iMax: wrapped,
    accPeak: wrapped + interpolated,
  };
}

function interpolatePeak(prevVal: number, peakVal: number, nextVal: number) {
  // Quadratic Interpolation of Spectral Peaks
  // https://ccrma.stanford.edu/~jos/sasp/Quadratic_Interpolation_Spectral_Peaks.html

  return 1 / 2 * (prevVal - nextVal) / (prevVal - 2 * peakVal + nextVal)
}
