import { useCallback, useEffect, useReducer, useState } from 'react';
import 'webrtc-adapter';
import Peer from 'peerjs';

import Button from 'react-bootstrap/Button';
import Col from 'react-bootstrap/Col';
import Collapse from 'react-bootstrap/Collapse';
import Container from 'react-bootstrap/Container';
import Form from 'react-bootstrap/Form';
import InputGroup from 'react-bootstrap/InputGroup';
import Row from 'react-bootstrap/Row';
import Spinner from 'react-bootstrap/Spinner';

import 'react-circular-progressbar/dist/styles.css';

import { useCounter, useLatest, useToggle } from 'react-use';

import { resumeAudioContext } from './MediaTools';
import doLongRecordToAlign, { LongRecordToAlignResultType } from './recordAndAlign';
import AudioStreamVisualizer from './AudioStreamVisualizer';
import LongRecordCorrelationModal from './LongRecordCorrelationModal';

import './CallView.css';

interface PeakStateType {
  time: number,
  peak: number,
  prevPeak: number,
  valid: boolean,
}

interface PeakStateWithDelaysType extends PeakStateType {
  joinDelay: number,
  joinDelayFine: number,
  totalJoinDelay: number,
  autoAdjustDelays: boolean,
  lastValidTime: number,
}

export interface PeakStateActionType {
  type: 'set' | 'valid' | 'invalid',
  time: number,
  peak: number,
  sampleRate?: number,
}

interface PeakStateWithDelaysActionType {
  type: 'set' | 'valid' | 'invalid' | 'setJoinDelay' | 'setJoinDelayCoarse' | 'setJoinDelayFine' | 'toggleAutoAdjust',
  time: number,
  peak?: number,
  sampleRate?: number,
}

function peakStateReducer(state: PeakStateType, action: PeakStateActionType): PeakStateType {
  switch (action.type) {
    case 'set':
      return { time: action.time, peak: action.peak, prevPeak: state.peak, valid: state.valid };
    case 'valid':
      // action.time always changes, the state has to change
      return { time: action.time, peak: action.peak, prevPeak: state.peak, valid: true };

    case 'invalid':
      if (state.valid) {
        return { time: action.time, peak: action.peak, prevPeak: state.peak, valid: false };
      }
      return state;

    default:
      const _exhaustiveCheck: never = action.type;
      throw new Error(_exhaustiveCheck);
  }
}

function peakStateWithDelaysReducer(
      state: PeakStateWithDelaysType,
      action: PeakStateWithDelaysActionType
    ): PeakStateWithDelaysType {

  switch (action.type) {
    case 'set':
      return {
        ...state,
        time: action.time,
        peak: action.peak || 0,
        prevPeak: state.peak,
     };
    case 'valid':
      return {
        ...state,
        time: action.time,
        peak: action.peak || 0,
        prevPeak: state.peak,
        valid: true
      };

    case 'invalid':
      if (state.valid) {
        return {
          ...state,
          time: action.time,
          peak: action.peak || 0,
          prevPeak: state.peak,
          valid: false
        };
      }
      return state;

    case 'setJoinDelay':
      const coarseShift = +action.time.toFixed(2);
      const fineShift = action.time - coarseShift;

      if (coarseShift !== state.joinDelay || fineShift !== state.joinDelayFine) {
        return {
          ...state,
          joinDelay: coarseShift,
          joinDelayFine: fineShift,
          totalJoinDelay: coarseShift + fineShift,
        };
      }
      return state;

    case 'setJoinDelayCoarse':
      if (action.time !== state.joinDelay) {
        const totalDelay = action.time + state.joinDelayFine;
        return {
          ...state,
          joinDelay: action.time,
          totalJoinDelay: totalDelay,
        };
      }
      return state;

    case 'setJoinDelayFine':
      if (action.time !== state.joinDelayFine) {
        const totalDelay = action.time + state.joinDelay;
        return {
          ...state,
          joinDelayFine: action.time,
          totalJoinDelay: totalDelay,
        };
      }
      return state;

    case 'toggleAutoAdjust':
      return {
        ...state,
        autoAdjustDelays: !state.autoAdjustDelays,
      }

    default:
      const _exhaustiveCheck: never = action.type;
      throw new Error(_exhaustiveCheck);
  }
}

interface CallViewProps {
  call: Peer.MediaConnection | null,
  ownMediaCh0: MediaStream | AudioNode | null,
  ownMediaCh1: MediaStream | AudioNode | null,
  audioCtx: AudioContext | null,
  callIsConnected: () => void,
}

const CallView = ({
  call,
  ownMediaCh0,
  ownMediaCh1,
  audioCtx,
  callIsConnected
}: CallViewProps): JSX.Element | null => {

  const [connectingCall, setConnectingCall] = useState<boolean>(true);

  const [peerMediaStream, setPeerMediaStream] = useState<MediaStream | null>(null);

  const [gainOwn, setGainOwn] = useState<number>(0.5);
  const [gainPeer, setGainPeer] = useState<number>(0.5);
  // invert one of the synchronization signals by default
  const [invertSynchro, toggleInvertSynchro] = useToggle(true);

  const [detectedPeak, peakDispatch] = useReducer(
    peakStateReducer,
    { time: -1, peak: -1, prevPeak: -1, valid: false }
  );
  const detectedPeakLatest = useLatest(detectedPeak);

  const [peakSynchronizer, peakSynchronizerDispatch] = useReducer(
    peakStateWithDelaysReducer,
    {
      time: -1, peak: -1, prevPeak: -1, valid: false,
      joinDelay: -0.1, joinDelayFine: 0, totalJoinDelay: -0.1,
      autoAdjustDelays: true, lastValidTime: 0
    }
  );
  const peakSynchronizerLatest = useLatest(peakSynchronizer);

  const [showLongCorrelationModal, setShowLongCorrelationModal] = useState<boolean>(false);
  const [longRecorder, setLongRecorder] = useState<LongRecordToAlignResultType | null>(null);
  const [applyTimeShiftToSynchrOffset, setApplyTimeShiftToSynchrOffset] = useState<boolean>(false);
  const [synchronizationTimeOffset, setSynchronizationTimeOffset] = useState<number>(0);
  const [keepSynchroStatus, setKeepSynchroStatus] = useState<string>('initializing');
  const [autoRecordingLength, { inc: incAutoRecordingLength }] = useCounter(4.1);

  const [showExtraControls, toggleShowExtraControls] = useToggle(false);

  const [peerMediaCh0, peerMediaCh1] = useStereoStreamSplitter(audioCtx, peerMediaStream);

  // chromium uses 48000!
  const SAMPLE_RATE = audioCtx?.sampleRate || 44100;

  useEffect(() => {
    if (ownMediaCh1 && peerMediaCh1) {
      let mounted = true;
      let status = 'initializing';
      setKeepSynchroStatus(status);
      let initialRecordsDone = 0;
      let recording = false;
      let recordingWhat = '';
      const lastValids = [true, true, true];
      let lastIndex = 0;
      let failCount = 0;

      const looper = setInterval(() => {
        function updateLongCorrelation(res: LongRecordToAlignResultType) {
          status = res.recording ? 'recording'
            : res.processing ? 'processing' : 'ready';
          status = `${status} (${recordingWhat})`;

          if (!res.recording && !res.processing) {
            console.log('Finished with ', res.result);
            recording = false;

            (res.sampleURL1 && URL.revokeObjectURL(res.sampleURL1));
            (res.sampleURL2 && URL.revokeObjectURL(res.sampleURL2));

            if (isNaN(res.result)) {
              status = 'failed';
              failCount++;
            } else {
              initialRecordsDone++;
              const offset = res.result / 16000;
              if (initialRecordsDone === 1) {
                setSynchronizationTimeOffset(offset); // - peakSynchronizerLatest.current.totalJoinDelay);
              } else {
                peakSynchronizerDispatch({
                  type: 'setJoinDelay',
                  time: offset
                });
              }
            }
          }
        };

        if (mounted) {
          setKeepSynchroStatus(status);
          if (initialRecordsDone < 1 && !recording) {
            recording = true;
            recordingWhat = 'synchronization signal';
            doLongRecordToAlign(autoRecordingLength, ownMediaCh1, peerMediaCh1,
              updateLongCorrelation, audioCtx || undefined).then(updateLongCorrelation);
          }
          if (initialRecordsDone < 2 && !recording) {
            recording = true;
            recordingWhat = 'real audio';
            doLongRecordToAlign(autoRecordingLength, ownMediaCh0, peerMediaCh0,
              updateLongCorrelation, audioCtx || undefined).then(updateLongCorrelation);
          }
          const synchro = peakSynchronizerLatest.current;
          if (initialRecordsDone >= 2) {
            lastValids[lastIndex] = synchro.valid;
            lastIndex = (lastIndex + 1) % lastValids.length;
            const isStable = lastValids.every(val => val);

            if (synchro.valid && synchro.peak) {
              const shift = synchro.peak / SAMPLE_RATE;
              // apply in the synchronization signal
              setSynchronizationTimeOffset(old => old + shift);
              status = 'adjusted by ' + shift.toFixed(5) + 's';
              setKeepSynchroStatus(status);

              if (synchro.autoAdjustDelays) {
                // apply also in the payload signal
                peakSynchronizerDispatch({
                  type: 'setJoinDelay',
                  time: synchro.totalJoinDelay + shift
                });
              }
            } else {
              status = 'ready (' + (isStable ? 'stable' : 'unstable') + ')';
            }
          }

          if (failCount >= 5) {
            clearInterval(looper);
            status = 'disabled after  ' + failCount + ' tries';
            setKeepSynchroStatus(status);
          }
        }
      }, 3000);

      return () => {
        clearInterval(looper);
        mounted = false;
      };
    }
  }, [ownMediaCh0, peerMediaCh0, ownMediaCh1, peerMediaCh1, SAMPLE_RATE,
        audioCtx, peakSynchronizerLatest, autoRecordingLength]);

  useEffect(() => {
    const callClosed = () => {
      console.log('Call closed.');
      setPeerMediaStream(null);
      setConnectingCall(true);
    };

    const callError = (err: any) => {
      console.error('Call error:', err);
      setPeerMediaStream(null);
      setConnectingCall(true);
    };

    const callStream = (stream: MediaStream) => {
      // `stream` is the MediaStream of the remote peer.
      // Here you'd add it to an HTML video/canvas element.
      console.log('Call stream added: ', stream);
      setPeerMediaStream(stream);
      setConnectingCall(false);
      callIsConnected();
    };

    if (call) {
      // register new listeners
      console.log('Registering listeners on call: ', call);
      call.on('stream', callStream);
      call.on('close', callClosed);
      call.on('error', callError);
    }

    return () => {
      if (call) {
        console.log('Un-registering listeners on call: ', call);
        call.off('stream', callStream);
        call.off('close', callClosed);
        call.off('error', callError);
      }
    };
  }, [call, callIsConnected]);

  const triggerScanForPeak = useCallback(() => {
    console.log('Looking for correlation peak');
    setApplyTimeShiftToSynchrOffset(false);

    function updateLongCorrelationModal(res: LongRecordToAlignResultType) {
      setLongRecorder(res);
    };

    if (ownMediaCh0 && peerMediaCh0) {
      setShowLongCorrelationModal(true);
      doLongRecordToAlign(6, ownMediaCh0, peerMediaCh0,
        updateLongCorrelationModal, audioCtx || undefined).then(updateLongCorrelationModal);
    }

  }, [ownMediaCh0, peerMediaCh0, setShowLongCorrelationModal, audioCtx]);

  const triggerScanForPeakSynchro = useCallback(() => {
    console.log('Looking for correlation peak (synchronization signal)');
    setApplyTimeShiftToSynchrOffset(true);

    function updateLongCorrelationModal(res: LongRecordToAlignResultType) {
      setLongRecorder(res);
    };

    if (ownMediaCh1 && peerMediaCh1) {
      setShowLongCorrelationModal(true);
      doLongRecordToAlign(6, ownMediaCh1, peerMediaCh1,
        updateLongCorrelationModal, audioCtx || undefined).then(updateLongCorrelationModal);
    }

  }, [ownMediaCh1, peerMediaCh1, setShowLongCorrelationModal, audioCtx]);

  const applyTimeShiftAbsolute = useCallback((shift:number) => {
    if (applyTimeShiftToSynchrOffset) {
      const offset = shift;
      setSynchronizationTimeOffset(offset); // - peakSynchronizer.totalJoinDelay);
      return;
    }
    console.log('Applying absolute time shift ', shift);

    peakSynchronizerDispatch({ type: 'setJoinDelay', time: shift } );
  }, [applyTimeShiftToSynchrOffset]);

  const centerVisiblePeak = useCallback(() => {
    const detectedPeak = detectedPeakLatest.current;
    if (Date.now() - detectedPeak.time < 5000) {
      console.log('Centering the visible correlation peak at ', detectedPeak);
      const shift = detectedPeak.peak / SAMPLE_RATE;
      console.log('Shifting the visible correlation peak with ', shift);

      peakSynchronizerDispatch({ type: 'setJoinDelay', time: peakSynchronizer.totalJoinDelay + shift } );
    }
  }, [SAMPLE_RATE, detectedPeakLatest, peakSynchronizer.totalJoinDelay]);

  const jointStream0 = useJoinStreams(
      audioCtx,
      ownMediaCh0, gainOwn,
      peerMediaCh0, gainPeer,
      peakSynchronizer.totalJoinDelay);

  const jointStream1 = useJoinStreams(
      audioCtx,
      ownMediaCh1, gainOwn,
      peerMediaCh1, gainPeer * (invertSynchro ? -1 : 1),
      synchronizationTimeOffset);

  if (!call) {
    return null;
  }

  let controlsForJointMedia = null;
  if (jointStream0) {
    controlsForJointMedia = (
      <Form className="p-2">
        <p>Automatic synchronizer: {keepSynchroStatus}
          <Button variant="secondary" className="ml-2" onClick={() => incAutoRecordingLength(1)}>
            Try again
          </Button>
        </p>
        <Form.Group controlId="formCheckAutoAdjust">
          <Form.Check
            type="checkbox"
            label="Adjust the time shift automatically"
            checked={peakSynchronizer.autoAdjustDelays}
            onChange={() => peakSynchronizerDispatch({ type: 'toggleAutoAdjust', time: 0 })}
          />
        </Form.Group>

        <Row>
          <Col sm="3">Audio signal (left channel)</Col>
          <Col sm="9">
            <Button className="m-2" onClick={triggerScanForPeak} disabled={!ownMediaCh0 || !peerMediaStream}>
              Scan for Correlation
            </Button>
            <Button className="m-2" onClick={centerVisiblePeak}
              disabled={!detectedPeak.valid || (Date.now() - detectedPeak.time > 5000)}
            >
              Center Visible Peak
            </Button>
          </Col>
        </Row>

        <Button
          className="m-2"
          onClick={toggleShowExtraControls}
          aria-controls="extra-controls"
          aria-expanded={showExtraControls}>
          Show more controls
        </Button>
        <Collapse in={showExtraControls} mountOnEnter={true}
          onEntered={(elem) => { elem.scrollIntoView?.({ behavior: "smooth", block: "end" }); }}
        >
          <div id="extra-controls">
            <ExtraStreamControls
              gainOwn={gainOwn}
              setGainOwn={setGainOwn}
              gainPeer={gainPeer}
              setGainPeer={setGainPeer}
              invertSynchro={invertSynchro}
              toggleInvertSynchro={toggleInvertSynchro}
              peakSynchronizer={peakSynchronizer}
              peakSynchronizerDispatch={peakSynchronizerDispatch}
              synchronizationTimeOffset={synchronizationTimeOffset}
              setSynchronizationTimeOffset={setSynchronizationTimeOffset}
              triggerScanForPeakSynchro={triggerScanForPeakSynchro}
              noSynchroChannels={!ownMediaCh1 || !peerMediaCh1}
            />
          </div>
        </Collapse>
      </Form>
    );
  }

  const callSpinner = connectingCall ? (<>
    <Spinner
      as="span"
      animation="border"
      size="sm"
      role="status"
      aria-hidden="true"
    />
    <span>Connecting...</span>
  </>) : null;

  let longModal = null;
  if (showLongCorrelationModal && longRecorder) {
    longModal = (
      <LongRecordCorrelationModal
        recording={longRecorder.recording}
        processing={longRecorder.processing}
        result={longRecorder.result}
        timeShiftGraphData={longRecorder.correlation}
        sampleURL1={longRecorder.sampleURL1}
        sampleURL2={longRecorder.sampleURL2}
        onClose={() => {
          setShowLongCorrelationModal(false);
          (longRecorder.sampleURL1 && URL.revokeObjectURL(longRecorder.sampleURL1));
          (longRecorder.sampleURL2 && URL.revokeObjectURL(longRecorder.sampleURL2));
          setLongRecorder(null);
        }}
        onApplyOffset={applyTimeShiftAbsolute}
      />
    );
  }

  return (
    <Container>
      {callSpinner}
      <Row>
        <Col>
          <AudioStreamVisualizer audioContext={audioCtx} mediaStream={peerMediaCh0} label="Peer left" muted={true} />
        </Col>
        <Col>
          <AudioStreamVisualizer audioContext={audioCtx} mediaStream={peerMediaCh1} label="Peer right" muted={true} />
        </Col>
      </Row>
      <Row>
        <Col>
          <AudioStreamVisualizer audioContext={audioCtx}
              mediaStream={jointStream0.out}
              extraVisuals={jointStream0.finalNodes}
              peakReporter={peakDispatch}
              label="Joined left" muted={true} />
        </Col>
        <Col>
          <AudioStreamVisualizer audioContext={audioCtx}
              mediaStream={jointStream1.out}
              extraVisuals={jointStream1.finalNodes}
              showDistanceBasedGraph={false}
              peakReporter={peakSynchronizerDispatch}
              peakReporterThreshold={0.8}
              label="Joined right" muted={true} />
        </Col>
      </Row>
      <Row>
        <Col>
          {controlsForJointMedia}
        </Col>
      </Row>
      {longModal}
    </Container>
  );
};

/**
 * Attemps to split a stereo (audio) stream into left and right channels.
 */
export function useStereoStreamSplitter(audioContext: AudioContext|null, mediaStream: MediaStream|null) {
  const [channel0, setChannel0] = useState<MediaStream|AudioNode|null>(null);
  const [channel1, setChannel1] = useState<MediaStream|AudioNode|null>(null);

  useEffect(() => {
    if (mediaStream && audioContext) {
      const sourceTracks = mediaStream.getAudioTracks();
      // Firefox's getSettings() returns {} -- assume 2 channels
      const channelCount = sourceTracks.length && (sourceTracks[0].getSettings().channelCount || 2);

      console.log('Audio tracks in the stream: ', sourceTracks.length);
      console.log('Splitting audio, channel count: ', channelCount, sourceTracks[0], sourceTracks[0]?.getSettings());

      if (sourceTracks.length === 0 || channelCount < 2) {
        setChannel0(mediaStream);
        setChannel1(null);

        return () => {
          setChannel0(null);
        };
      }

      let origSource: AudioNode;
      if (audioContext.createMediaStreamTrackSource) {
        origSource = audioContext.createMediaStreamTrackSource(sourceTracks[0]);
      } else {
        // if there are more than one audio track, this might not use the expected one
        origSource = audioContext.createMediaStreamSource(mediaStream);
      }

      const splitter = audioContext.createChannelSplitter(2);
      origSource.connect(splitter);

      const dest0 = audioContext.createGain();
      const dest1 = audioContext.createGain();

      splitter.connect(dest0, 0, 0);
      splitter.connect(dest1, 1, 0);

      setChannel0(dest0);
      setChannel1(dest1);

      // For Chromium: https://bugs.chromium.org/p/chromium/issues/detail?id=933677
      const dummySink = new Audio();
      dummySink.srcObject = mediaStream;

      return () => {
        dummySink.srcObject = null;
        origSource.disconnect();
        splitter.disconnect();
        setChannel0(null);
        setChannel1(null);
      };
    }
  }, [audioContext, mediaStream]);

  return [channel0, channel1];
}

function useJoinStreams(
      audioCtx: AudioContext | null,
      stream1: MediaStream | AudioNode | null,
      gain1: number,
      stream2: MediaStream | AudioNode | null,
      gain2: number,
      delay: number) {

  const [gainNodes, setGainNodes] = useState<Array<GainNode | null>>([null, null]);
  const [delayNodes, setDelayNodes] = useState<Array<DelayNode | null>>([null, null]);
  const [outStream, setOutStream] = useState<MediaStream | null>(null);

  function useAudioNodeChain(
        audioCtx: AudioContext | null,
        stream: MediaStream | AudioNode | null,
        valueIndex: number) {

    useEffect(() => {
      console.log('Effect, create chain ', valueIndex, stream);
      const [ source, gainNode, delay ] = buildChain(audioCtx, stream, 0.5, 5.0);
      if (gainNode instanceof GainNode || gainNode == null) {
        setGainNodes(g => [valueIndex===0 ? gainNode: g[0], valueIndex===1 ? gainNode: g[1]]);
      }
      if (delay instanceof DelayNode || delay == null) {
        setDelayNodes(d => [valueIndex===0 ? delay: d[0], valueIndex===1 ? delay: d[1]]);
      }

      if (stream) {
        // deal with: "The AudioContext was not allowed to start. It must be resumed (or created)
        // after a user gesture on the page. https://goo.gl/7K7WLu"
        resumeAudioContext(audioCtx);
      }

      return () => {
        console.log('Effect, destroy chain ', valueIndex);
        if (gainNode) {
          source?.disconnect(gainNode);
          gainNode.disconnect();
        }
        // delayNodes are dis/connected later together with outStream
        //delay?.disconnect();

        setGainNodes(g => [valueIndex===0 ? null: g[0], valueIndex===1 ? null: g[1]]);
        setDelayNodes(d => [valueIndex===0 ? null: d[0], valueIndex===1 ? null: d[1]]);
      }
    }, [audioCtx, stream, valueIndex]);
  }

  useAudioNodeChain(audioCtx, stream1, 0);
  useAudioNodeChain(audioCtx, stream2, 1);

  useEffect(() => {
    gainNodes[0]?.gain.setValueAtTime(gain1, audioCtx?.currentTime || 0);
  }, [gain1, audioCtx, gainNodes]);

  useEffect(() => {
    gainNodes[1]?.gain.setValueAtTime(gain2, audioCtx?.currentTime || 0);
  }, [gain2, audioCtx, gainNodes]);

  useEffect(() => {
    let delay1 = delay < 0 ? -delay : 0;
    let delay2 = delay > 0 ?  delay : 0;

    delayNodes[0] && (delayNodes[0].delayTime.value = delay1);
    delayNodes[1] && (delayNodes[1].delayTime.value = delay2);
  }, [delay, delayNodes]);

  useEffect(() => {
    console.log('Effect outStream');
    if (audioCtx && audioCtx.state !== "closed") {
      const dest = audioCtx.createMediaStreamDestination();
      delayNodes[0]?.connect(dest);
      delayNodes[1]?.connect(dest);
      setOutStream(dest.stream);

      return () => {
        console.log('Effect, close old outStream', dest);
        delayNodes[0]?.disconnect(dest);
        delayNodes[1]?.disconnect(dest);
        dest.disconnect();
        setOutStream(null);
      };
    }
  }, [audioCtx, gainNodes, delayNodes]);

  return {
    out: outStream,
    finalNodes: delayNodes,
  };
}

function buildChain(
      audioCtx: AudioContext | null,
      stream: MediaStream | AudioNode | null,
      gain: number,
      delay: number) {
  if (!audioCtx || !stream) {
    return [null, null];
  }
  console.log('Building chain for ', stream);
  const source = (stream instanceof AudioNode)
    ? stream
    : audioCtx.createMediaStreamSource(stream);
  const gainNode = audioCtx.createGain();
  gainNode.gain.setValueAtTime(gain, audioCtx.currentTime);
  source.connect(gainNode);
  const delayNode = audioCtx.createDelay(delay); // max delay
  gainNode.connect(delayNode);

  return [ source, gainNode, delayNode ];
}

interface ExtraStreamControlsProps {
  gainOwn: number,
  setGainOwn: (g: number) => void,
  gainPeer: number,
  setGainPeer: (g: number) => void,
  invertSynchro: boolean,
  toggleInvertSynchro: () => void,
  peakSynchronizer: PeakStateWithDelaysType,
  peakSynchronizerDispatch: React.Dispatch<PeakStateWithDelaysActionType>,
  synchronizationTimeOffset: number,
  setSynchronizationTimeOffset: (o: number) => void,
  triggerScanForPeakSynchro: () => void,
  noSynchroChannels: boolean,
}
function ExtraStreamControls(props: ExtraStreamControlsProps) {
  const {
    gainOwn,
    setGainOwn,
    gainPeer,
    setGainPeer,
    invertSynchro,
    toggleInvertSynchro,
    peakSynchronizer,
    peakSynchronizerDispatch,
    synchronizationTimeOffset,
    setSynchronizationTimeOffset,
    triggerScanForPeakSynchro,
    noSynchroChannels
  } = props;

  return (
    <div>
      <Form.Group as={Row} controlId="formGainOwn">
        <Form.Label column sm="3">Gain Own: {gainOwn}</Form.Label>
        <Col sm="9">
          <Form.Control type="range" value={gainOwn} min={-1} max={1} step={0.01}
            onChange={(evt) => setGainOwn(+evt.target.value)} />
        </Col>
      </Form.Group>
      <Form.Group as={Row} controlId="formGainPeer">
        <Form.Label column sm="3">Gain Peer: {gainPeer}</Form.Label>
        <Col sm="9">
          <Form.Control type="range" value={gainPeer} min={-1} max={1} step={0.01}
            onChange={(evt) => setGainPeer(+evt.target.value)} />
        </Col>
      </Form.Group>
      <Form.Group as={Row} controlId="formCheckInvertOne">
        <Col>
          <Form.Check
            type="checkbox"
            label="Invert one synchronization signal"
            checked={invertSynchro}
            onChange={toggleInvertSynchro}
          />
        </Col>
      </Form.Group>

      <Form.Group as={Row} controlId="formJoinDelay">
        <Form.Label column sm="3">Time-shift in Mixing: {(peakSynchronizer.totalJoinDelay).toFixed(5)}s</Form.Label>
        <Col sm="9">
          <Form.Control type="range" value={peakSynchronizer.joinDelay} min={-4.9} max={4.9} step={0.01}
            onChange={(evt) => peakSynchronizerDispatch({ type: 'setJoinDelayCoarse', time: +evt.target.value })} />
        </Col>
      </Form.Group>
      <Form.Group as={Row} controlId="formJoinDelayFine">
        <Form.Label column sm="3">Fine-tuning: {peakSynchronizer.joinDelayFine.toFixed(5)}s</Form.Label>
        <Col sm="9">
          <Form.Control type="range" value={peakSynchronizer.joinDelayFine} min={-0.1} max={0.1} step={0.00001}
            onChange={(evt) => peakSynchronizerDispatch({ type: 'setJoinDelayFine', time: +evt.target.value })} />
        </Col>
      </Form.Group>

      <Form.Group as={Row} controlId="formSynchroOffset">
        <Form.Label column sm="3">
          Synchronization signal offset (right channel)
        </Form.Label>
        <Col sm="9">
          <InputGroup size="sm">
            <Form.Control
              placeholder="time offset"
              type="number"
              value={synchronizationTimeOffset.toFixed(5)}
              onChange={(event) => setSynchronizationTimeOffset(+event.target.value)} />
            <InputGroup.Append>
              <Button onClick={triggerScanForPeakSynchro} disabled={noSynchroChannels}>
                Scan for Correlation
          </Button>
            </InputGroup.Append>
          </InputGroup>
        </Col>
      </Form.Group>
    </div>
  );
}

export default CallView;
