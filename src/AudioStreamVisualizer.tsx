import {
  Dispatch, forwardRef, useCallback,
  useEffect, useImperativeHandle,
  useRef, useState
} from "react";

import Button from 'react-bootstrap/Button';
import Collapse from 'react-bootstrap/Collapse';
import Form from 'react-bootstrap/Form';

import { useStateList, useToggle } from 'react-use';

import _uniqueId from 'lodash/uniqueId';

import { PeakStateActionType } from "./CallView";
import { useEnumerateMediaDevices } from "./MediaTools";

import { analyseCorrelationSignal, TimeshiftCanvas } from './TimeshiftCanvas';
import TimeshiftSvgVisualizer from './TimeshiftSvgVisualizer';

import crossCorrelation from './workers/crossCorrelationWorker';
//import crossCorrelation from './workers/crossCorrelation';

import './AudioStreamVisualizer.css';

// a power of two in the range 32 to 32768
//const ANALYSIS_FFT_SIZE = 2048;
const ANALYSIS_FFT_SIZE = 4096;
const VOLUME_ONLY_FFT_SIZE = 32;


interface AudioStreamVisualizerProps {
      audioContext: AudioContext | null,
      mediaStream: MediaStream | AudioNode | null,
      extraVisuals?: Array<AudioNode | null> | null,
      peakReporter?: Dispatch<PeakStateActionType>,
      peakReporterThreshold?: number,
      label: string,
      muted: boolean,
      showDistanceBasedGraph?: boolean,
}

export default function AudioStreamVisualizer({
      audioContext,
      mediaStream,
      extraVisuals,
      peakReporter,
      peakReporterThreshold=0.8,
      label,
      muted=false,
      showDistanceBasedGraph=true,
    }: AudioStreamVisualizerProps ): JSX.Element | null {

  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [selectedOut, setSelectedOut] = useState<string | null>(null);
  const [slowMode, setSlowMode] = useState<boolean>(false);
  const [stopTime, setStopTime] = useState<number>(-1);
  const [audioOffset, setAudioOffset] = useState<number>(0);
  const [timeShiftGraphData, setTimeShiftGraphData] = useState<number[]>([]);
  const [analysed, setAnalysed] = useState<ReturnType<typeof analyseCorrelationSignal>>();

  const [miniMode, toggleMiniMode] = useToggle(true);

  const SAMPLE_RATE = audioContext?.sampleRate || 44100;
  const FFT_SIZE = miniMode && !extraVisuals ? VOLUME_ONLY_FFT_SIZE : ANALYSIS_FFT_SIZE;

  const canvasRef = useCallback(node => {
    setCanvas(node);
  }, []);

  useEffect(() => {
    peakReporter?.({ type: 'set', time: Date.now(), peak: audioOffset });
  }, [audioOffset, peakReporter]);

  const audioElemRef = useCallback((node: HTMLAudioElement) => {
    if (node != null) {
      let realStream = null;
      if (mediaStream instanceof AudioNode) {
        const streamNode = audioContext?.createMediaStreamDestination();
        if (streamNode) {
          mediaStream.connect(streamNode);
          realStream = streamNode.stream;
        }
      } else {
        realStream = mediaStream;
      }

      node.srcObject = realStream;

      const outSpk = selectedOut && JSON.parse(selectedOut).d;
      // @ts-ignore
      if (typeof node.sinkId !== 'undefined' && outSpk) {
        // @ts-ignore
        node.setSinkId(outSpk)
        .then(() => {
          console.log(`Success, audio output device attached: ${selectedOut}`);
        })
        .catch((error: any) => {
          let errorMessage = error;
          if (error.name === 'SecurityError') {
            errorMessage = `You need to use HTTPS for selecting audio output device: ${error}`;
          }
          console.error(errorMessage);
        });
      }
    }
  }, [mediaStream, selectedOut, audioContext]);

  useEffect(() => {
    // thanks to https://github.com/mdn/web-dictaphone/blob/gh-pages/scripts/app.js
    // used pursuant to license: Creative Commons Zero v1.0 Universal
    //const stream = mediaStream;
    let stopIt = false;
    console.log('visualize() init', mediaStream);

    if (!mediaStream || !audioContext || !canvas) {
      return;
    }

    const audioCtx = audioContext;

    const source = (mediaStream instanceof AudioNode)
      ? mediaStream
      : audioCtx.createMediaStreamSource(mediaStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    const bufferLength = analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);

    source.connect(analyser);

    let otherDataArrays: Float32Array[] = [];
    const otherAnalysers = (extraVisuals || []).map(item => {
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      item?.connect(analyser);
      otherDataArrays.push(new Float32Array(bufferLength));
      return analyser;
    });

    let canvasCtx = canvas?.getContext("2d");

    let correlationRunning = false;
    let correlationsRun = 0;
    let correlationsSkipped = 0;

    function drawOne(dataArray: ArrayLike<number>, strokeStyle: string) {
      if (! canvas || ! canvasCtx) {
        return;
      }

      const WIDTH = canvas.width;
      const HEIGHT = canvas.height;

      canvasCtx.strokeStyle = strokeStyle;
      canvasCtx.beginPath();

      let sliceWidth = WIDTH * 1.0 / bufferLength;
      let x = 0;

      for(let i = 0; i < bufferLength; i++) {
        let v = dataArray[i] + 1;
        let y = v * HEIGHT/2;

        if(i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      canvasCtx.lineTo(canvas.width, canvas.height/2);
      canvasCtx.stroke();
    }

    function drawDifference(
          array1: ArrayLike<number>,
          array2: ArrayLike<number>,
          strokeStyle: string) {

      if (! canvas || ! canvasCtx) {
        return;
      }

      const WIDTH = canvas.width;
      const HEIGHT = canvas.height;

      canvasCtx.strokeStyle = strokeStyle;
      canvasCtx.beginPath();

      let sliceWidth = WIDTH * 1.0 / bufferLength;
      let x = 0;

      for(let i = 0; i < bufferLength; i++) {
        let v = Math.abs(Math.abs(array1[i]) - Math.abs(array2[i])) / 2;
        let y = HEIGHT - v * HEIGHT;

        if(i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      canvasCtx.stroke();
    }

    const runCorrelation = async() => {
      const correlation = await crossCorrelation(otherDataArrays[0], otherDataArrays[1]);
      correlationsRun++;
      correlationRunning = false;
      //console.log(correlation);

      if (!stopIt) {
        setTimeShiftGraphData((oldData) => {
          if (oldData.length !== correlation.xcorr.length) {
            return correlation.xcorr;
          }
          // smooth the data with the previous values
          const weight = 0.1;
          const oldWeight = 1 - weight;
          const data = correlation.xcorr.map((item, i) => weight*item + oldWeight*oldData[i]);
          const n = data.length;

          let imax = data.reduce((iMax, x, i, arr) => Math.abs(x) > Math.abs(arr[iMax]) ? i : iMax, 0);
          imax = imax < n / 2 ? imax : imax - n;
          setAudioOffset(imax);

          return data;
        });
      }
    }

    function draw() {
      if (stopIt) {
        // exit the infinite loop
        return;
      }

      if (canvas && !canvasCtx) {
        canvasCtx = canvas.getContext("2d");
      }
      if (! canvas || ! canvasCtx) {
        return;
      }

      const WIDTH = canvas.width
      const HEIGHT = canvas.height;

      analyser.getFloatTimeDomainData(dataArray);

      otherAnalysers.forEach((item, index) => {
        item.getFloatTimeDomainData(otherDataArrays[index]);
      });

      if (otherDataArrays.length === 2) {
        if (!correlationRunning) {
          correlationRunning = true;
          runCorrelation();
        } else {
          correlationsSkipped++;
        }
      }

      if (slowMode) {
        // skip drawing, if nothing interesting happened
        let isBoring = false;
        const boringCondition = (elem: number) => elem > 108 && elem < 148;
        if (dataArray.every(boringCondition)) {
          isBoring = true;
        }

        if (!isBoring && otherDataArrays.length === 2) {
          if (otherDataArrays[0].every(boringCondition)
                || otherDataArrays[1].every(boringCondition)) {
            isBoring = true;
          }
        }

        // make a short pause, if the content is deemed "interesting"
        if (isBoring) {
          setStopTime(-1);
          requestAnimationFrame(draw);
        } else {
          setStopTime(audioCtx.currentTime % 1000);
          setTimeout(() => requestAnimationFrame(draw), 500);
        }
      } else {
        //requestAnimationFrame(draw);
        setTimeout(() => requestAnimationFrame(draw), 100);
      }

      canvasCtx.fillStyle = 'rgb(200, 200, 200)';
      canvasCtx.fillRect(0, 0, WIDTH, HEIGHT);
      canvasCtx.lineWidth = 2;

      drawOne(dataArray, 'rgb(0, 0, 0)');

      otherDataArrays.forEach((item, index) => {
        drawOne(otherDataArrays[index], index===0 ? 'rgb(255, 0, 0)' : 'rgb(0, 255, 0)');
      });
      if (otherDataArrays.length === 2) {
        drawDifference(otherDataArrays[0], otherDataArrays[1], 'rgb(0, 0, 255)');
      }
    }

    draw();

    return () => {
      console.log('Stopping visualize() for ', mediaStream);
      stopIt = true;
      source.disconnect(analyser);
      console.log(`Correlation runs executed/skipped: ${correlationsRun}/${correlationsSkipped}`);
    }
  }, [canvas, mediaStream, audioContext, extraVisuals, slowMode, setStopTime, label, peakReporter, FFT_SIZE]);

  useEffect(() => {
    if (timeShiftGraphData) {
      const res = analyseCorrelationSignal(
        timeShiftGraphData, audioOffset, peakReporterThreshold, 0.003 * SAMPLE_RATE);
      setAnalysed(res);

      peakReporter?.({
        type: (res.isValidPeak ? 'valid' : 'invalid'),
        time: Date.now(),
        peak: audioOffset,
        sampleRate: SAMPLE_RATE
      });
    }
  }, [SAMPLE_RATE, timeShiftGraphData, audioOffset, peakReporter, peakReporterThreshold]);

  if (mediaStream) {
    const wrapper = (
      <div>
        <p>{label}</p>
        <canvas ref={canvasRef}
          className={miniMode ? 'wave-closed' : 'wave-open'}
          width={miniMode ? 50 : 400} height={100}
          onClick={toggleMiniMode} />
        <div className="d-inline-flex justify-content-between">
          <MiniAudio ref={audioElemRef} muted={muted} autoPlay />
          <AudioTargetSelector selectedOut={selectedOut} setSelectedOut={setSelectedOut} />
        </div>
        <Form.Check
          type="checkbox"
          title="stop the visualization briefly when audio waves are visible"
          label={"slow visualization" + (stopTime >= 0 ? ' (' + stopTime.toFixed(5) + 's)' : '')}
          checked={slowMode}
          onChange={() => setSlowMode(!slowMode)}
        />
        {extraVisuals && (<br />)}
        {extraVisuals && (
            <ShiftGraphContainer
              data={timeShiftGraphData}
              analysed={analysed}
              audioOffset={audioOffset}
              sampleRate={SAMPLE_RATE}
              showDistanceBasedGraph={showDistanceBasedGraph}
            />
          )
        }
      </div>
    );

    return wrapper;

  } else {
    return null;
  }
}

const timeShiftZoomValues = [2, 4, 8, 16, 32];

interface ShiftGraphContainerProps {
  data: number[],
  analysed: ReturnType<typeof analyseCorrelationSignal> | undefined,
  audioOffset: number,
  sampleRate: number,
  showDistanceBasedGraph: boolean,
}
function ShiftGraphContainer(props: ShiftGraphContainerProps) {
  const { data: timeShiftGraphData, sampleRate: SAMPLE_RATE,
    audioOffset, analysed, showDistanceBasedGraph } = props;

  const { state: zoomDivider, next: nextZoom } = useStateList(timeShiftZoomValues);

  const viewSize = timeShiftGraphData.length / zoomDivider;
  const graphEdge = (viewSize / SAMPLE_RATE).toFixed(3);

  return (
    <div onClick={nextZoom}>
      <span>{`${audioOffset}  ${(audioOffset / SAMPLE_RATE).toFixed(6)}s`}</span>
      <TimeshiftCanvas
        data={timeShiftGraphData} width={800} height={200}
        peakIndex={audioOffset}
        analysis={analysed}
        // this many samples (on either side) can be above the threshold
        peakWidth={0.003 * SAMPLE_RATE}
        labels={[`-${graphEdge}s`, '0', `${graphEdge}s`]}
        minDraw={timeShiftGraphData.length / 2 - viewSize}
        maxDraw={timeShiftGraphData.length / 2 + viewSize}
      />

      {showDistanceBasedGraph && (
        <TimeshiftSvgVisualizer
          data={timeShiftGraphData} width={800} height={200}
          peakIndex={audioOffset}
          analysis={analysed}
          // this many samples (on either side) can be above the threshold
          peakWidth={0.003 * SAMPLE_RATE}
          sampleRate={SAMPLE_RATE}
        />
      )}
    </div>
  );
}

interface AudioTargetSelectorProps {
  selectedOut: string | null,
  setSelectedOut: (choice: string) => void,
}

function AudioTargetSelector({
  selectedOut,
  setSelectedOut,
}: AudioTargetSelectorProps) {
  const [outSelectorOpen, toggleOutSelectorOpen] = useToggle(false);
  let outSelector = null;
  const audioOuts = useEnumerateMediaDevices(false).audioOuts;
  if (audioOuts.length >= 1) {
    const outOptions = audioOuts.map(item => (
      <option key={item.uuid} value={item.uuid}>{item.label}</option>
    ));

    outSelector = (
      <>
      <Button
        variant="light"
        size="sm"
        className="h-25"
        onClick={toggleOutSelectorOpen}
        aria-controls="form-choose-output"
        aria-expanded={outSelectorOpen}
        >
        🔈/🎧
      </Button>
      <Collapse in={outSelectorOpen}>
        <Form.Group controlId="formOutSelect" id="form-choose-output">
          <Form.Label>Use speakers:</Form.Label>
          <Form.Control as="select"
              value={selectedOut || undefined}
              onChange={(evt) => setSelectedOut(evt.target.value)}>
            {outOptions}
          </Form.Control>
        </Form.Group>
      </Collapse>
      </>
    );
  }
  return outSelector;
}

interface MiniAudioProps {
  autoPlay?: boolean,
  controls?: boolean,
  muted?: boolean,
}

const MiniAudio = forwardRef<any, MiniAudioProps>((props, ref) => {
  const [showVolume, toggleShowVolume] = useToggle(false);
  const [volume, setVolume] = useState<number>(props.muted ? 0 : 0.8);
  const [id] = useState(() => _uniqueId('volume-'));

  const audioRef = useRef<HTMLAudioElement>(null);

  useImperativeHandle(ref, () => (
    audioRef.current
  ), []);

  const updateVolume = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
    if (audioRef.current) {
      const vol = evt.currentTarget.valueAsNumber;
      setVolume(vol);
      audioRef.current.volume = vol;
      audioRef.current.muted = vol === 0;
    }
  }, [audioRef]);

  // 🔇🔈🔉🔊
  const icon =
    (volume === 0) ? '🔇' :
      ((volume < 0.33) ? '🔈' :
        (((volume < 0.66) ? '🔉' :
          '🔊')));

  return (<>
    <audio ref={audioRef} {...props} />

    <Button
      size="sm"
      onClick={toggleShowVolume}
      variant="light"
      aria-controls={id}
      aria-expanded={showVolume}
    >
      {icon}
    </Button>

    <Collapse in={showVolume}>
      <Form.Group controlId={"form" + id} id={id}>
        <Form.Label>volume</Form.Label>
        <Form.Control type="range" value={volume} min={0} max={1} step={0.05}
          onChange={updateVolume} />
      </Form.Group>
    </Collapse>
  </>);
});
