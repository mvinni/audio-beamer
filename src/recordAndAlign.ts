import recordrtc from "recordrtc";
import crossCorrelation from './workers/crossCorrelationWorker';

export interface LongRecordToAlignResultType {
  recording: boolean,
  processing: boolean,
  result: number,
  sampleURL1: string | null,
  sampleURL2: string | null,
  correlation: number[] | null,
}

export default async function doLongRecordToAlign(
  duration: number,
  stream1: MediaStream | AudioNode | null,
  stream2: MediaStream | AudioNode | null,
  onUpdate: (state: LongRecordToAlignResultType) => void,
  audioCtx?: AudioContext,
): Promise<LongRecordToAlignResultType> {

  const res: LongRecordToAlignResultType = {
    recording: false,
    processing: false,
    result: Number.NaN,
    sampleURL1: null,
    sampleURL2: null,
    correlation: null,
  };

  res.recording = true;
  onUpdate(res);

  const recorderOptions = {
    type: 'audio',
    mimeType: 'audio/wav',
    recorderType: recordrtc.StereoAudioRecorder,
    numberOfAudioChannels: 1,
    //sampleRate: 16000,
    desiredSampRate: 16000,
  };

  function wrapAudio(input: MediaStream | AudioNode | null): [MediaStream | null, () => void] {
    if (!input || !(input instanceof AudioNode)) {
      return [input, () => { }];
    }

    if (!audioCtx) {
      return [null, () => { }];
    }
    const dest = audioCtx.createMediaStreamDestination();
    input.connect(dest);
    return [dest.stream, () => {
      input.disconnect(dest);
    }];
  }

  const [input1, release1] = wrapAudio(stream1);
  const [input2, release2] = wrapAudio(stream2);

  // @ts-ignore  RecordRTCPromisesHandler is not covered by @types/recordrtc
  let recorder1 = new recordrtc.RecordRTCPromisesHandler(input1, recorderOptions);
  // @ts-ignore  RecordRTCPromisesHandler is not covered by @types/recordrtc
  let recorder2 = new recordrtc.RecordRTCPromisesHandler(input2, recorderOptions);
  recorder1.startRecording();
  recorder2.startRecording();

  await new Promise(resolve => setTimeout(resolve, duration * 1000));

  res.recording = false;
  res.processing = true;
  onUpdate(res);

  const promise1 = recorder1.stopRecording();
  const promise2 = recorder2.stopRecording();
  await Promise.all([promise1, promise2]);

  let data1 = await processRecording(recorder1);
  let data2 = await processRecording(recorder2);

  const blob1 = await recorder1.getBlob() as Blob;
  const blob2 = await recorder2.getBlob() as Blob;
  res.sampleURL1 = URL.createObjectURL(blob1);
  res.sampleURL2 = URL.createObjectURL(blob2);

  //console.log('Stop recording', blob1, blob2);

  recorder1.destroy();
  recorder2.destroy();
  release1();
  release2();

  if (data1 && data2) {
    if (data1.length < data2.length) {
      data2 = new Float32Array(data2.buffer, 0, data1.length);
    } else if (data2.length < data1.length) {
      data1 = new Float32Array(data1.buffer, 0, data2.length);
    }

    try {
      const correlation = await crossCorrelation(data1, data2);

      console.log('Correlation finished, ', correlation);
      res.result = correlation.accPeak;
      res.correlation = correlation.xcorr;

    } catch (err) {
      console.error('Correlation failed: ', err);
    }

  } else {
    console.error('Recording failed');
  }

  res.processing = false;
  return res;
}

async function processRecording(recorder: any) {
  var internalRecorder: recordrtc.StereoAudioRecorder = await recorder.getInternalRecorder();

  // @ts-ignore
  const dataView: DataView = internalRecorder.view;

  function compareUTFBytes(view: DataView, offset: number, string: string) {
    var lng = string.length;
    for (var i = 0; i < lng; i++) {
      const c = view.getUint8(offset + i);
      if (c !== string.charCodeAt(i)) {
        return false;
      }
    }
    return true;
  }

  // reverse the wave encoding from RecordRTC
  // data sub-chunk
  // data chunk identifier
  //writeUTFBytes(view, 36, 'data');
  if (!compareUTFBytes(dataView, 36, 'data')) {
    console.error('Wave data chunk identifier not found. RecordRTC version mis-match?');
    return;
  }

  // data chunk length in bytes -- double of int16 value length
  const dataLengthB = dataView.getUint32(40, true);

  // use the largest 2^k sized array available
  var k = Math.floor(Math.log(dataLengthB / 2) / Math.LN2)

  // from: view.setInt16(index, interleaved[i] * (0x7FFF * volume), true);
  // little-endian 16 bit signed values

  const data = new Int16Array(dataView.buffer, 44, Math.pow(2, k));
  console.log(`Using ${data.length} items out of ${dataLengthB / 2} (${(2 * 100 * data.length / dataLengthB).toFixed(2)} %)`);

  return convertAudioInt16ToFloat(data);
}

function convertAudioInt16ToFloat(array: Int16Array) {
  const n = array.length;
  const res = new Float32Array(n);
  for (let i=0; i<n; i++) {
    // interleaved[i] * (0x7FFF)
    res[i] = array[i] / 0x7FFF;
  }
  return res;
}
