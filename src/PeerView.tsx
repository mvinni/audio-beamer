import { useCallback, useEffect, useState } from 'react';
import Peer from 'peerjs';
import CallView, { useStereoStreamSplitter }  from './CallView';
import * as DSP from 'dsp.js';

import _forEach from 'lodash/forEach';
import _reduce from 'lodash/reduce';

import { useLatest, useToggle } from 'react-use';
import * as sdpTransform from 'sdp-transform';

import { getLocalAudioStream, useEnumerateMediaDevices } from './MediaTools';
import AudioStreamVisualizer from './AudioStreamVisualizer';

/// <reference path="helper-types.d.ts"/>
import QRCode from 'qrcode.react';
import QrReader from 'modern-react-qr-reader'
import Button from 'react-bootstrap/Button';
import Col from 'react-bootstrap/Col'
import Container from 'react-bootstrap/Container';
import Form from 'react-bootstrap/Form';
import InputGroup from 'react-bootstrap/InputGroup';
import Modal from 'react-bootstrap/Modal';
import Row from 'react-bootstrap/Row';
import Spinner from 'react-bootstrap/Spinner';

function useForceUpdate(){
    const setValue = useState(0)[1];
    return () => setValue(value => value + 1);
}

const PeerView = (): JSX.Element => {
  const [ownID, setOwnID] = useState<string>('');
  const [peerID, setPeerID] = useState<string>('');

  const [peer /*, setPeer*/] = useState<Peer>(() => new Peer({
    host: 'localhost',
    port: 9000,
    path: '/peerjs/beam'
  }));
  const [showQRReader, toggleShowQRReader] = useToggle(false);
  const [showQRCode, toggleShowQRCode] = useToggle(false);

  const [connectingCall, setConnectingCall] = useState<boolean>(false);
  const [waitingForUser, setWaitingForUser] = useState<boolean>(false);

  const [cmdConnection, setCmdConnection] = useState<Peer.DataConnection | null>(null);
  const [call, setCall] = useState<Peer.MediaConnection | null>(null);
  const currentCall = useLatest(call);

  const [incomingOffer, setIncomingOffer] = useState<Peer.MediaConnection | null>(null);
  const currentOffer = useLatest(incomingOffer);

  const [ownMediaStream, setOwnMediaStream] = useState<MediaStream | null>(null);
  const [selectedMic, setSelectedMic] = useState<string | null>(null);

  const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null);
  const [synchroStream, setSynchroStream] = useState<ReturnType<typeof addSynchronizerChannel> | null>(null);
  const [ownMediaCh0, ownMediaCh1] = useStereoStreamSplitter(audioCtx, synchroStream?.stream || null);

  const [peerServerStatus, setPeerServerStatus] = useState<string>('');
  const [peerConnCount, setPeerConnCount] = useState<number>(0);
  const forceUpdate = useForceUpdate();

  useEffect(() => {
    if (synchroStream) {
      return () => {
        // clean up synchronizer internals
        if (synchroStream.stoppables) {
          synchroStream.stoppables.forEach(stoppable => {
            if (stoppable.stop) {
              stoppable.stop();
            }
          });
        }
        if (synchroStream.disconnectables) {
          synchroStream.disconnectables.forEach(disconnectable => {
            disconnectable.disconnect();
          });
        }
      }
    }
  }, [synchroStream]);

  const requestStereo = (sdp: string) => {
    const parsed = sdpTransform.parse(sdp);
    const audioDesc = parsed.media.findIndex(obj => obj.type === 'audio');
    if (audioDesc >= 0) {
      const audio = parsed.media[audioDesc];
      const opus = audio.rtp.find(obj => obj.codec === 'opus');
      if (opus) {
        const payload = opus.payload;
        let fmtp = audio.fmtp.find(obj => obj.payload === payload);
        let params: sdpTransform.ParamMap;
        if (fmtp) {
          params = sdpTransform.parseParams(fmtp.config);
          params.stereo = 1;
          params['sprop-stereo'] = 1;
          fmtp.config = Object.keys(params).map(i => `${i}=${params[i]}`).join(';')
        } else {
          params = {
            stereo: 1,
            'sprop-stereo': 1,
          };
          audio.fmtp.push({
            payload: payload,
            config: Object.keys(params).map(i => `${i}=${params[i]}`).join(';'),
          });
        }
        //console.log('Modified fmtp section: ', audio.fmtp);
      }
      sdp = sdpTransform.write(parsed);

    } else {
      console.error('Not able to find an SDP audio section, hoping for the best');
    }

    return sdp;
  }

  const requestMic = useCallback(async () => {
    if (ownMediaStream && synchroStream) {
      return { mic: ownMediaStream, full: synchroStream.stream };
    }

    setWaitingForUser(true);
    const micStream = await getLocalAudioStream(selectedMic || undefined);
    setWaitingForUser(false);
    if (micStream) {
      let ac = audioCtx;
      if (!ac) {
        ac = new AudioContext({ latencyHint: 'playback' });
        setAudioCtx(ac);
      }
      const synchroStream = addSynchronizerChannel(micStream, ac);
      console.log('Local stream: ', micStream);
      setOwnMediaStream(micStream);
      setSynchroStream(synchroStream);
      return { mic: micStream, full: synchroStream.stream };
    }
  }, [selectedMic, audioCtx, ownMediaStream, synchroStream]);

  const callPeer = useCallback(async () => {
    const id = peerID;
    console.log('Trying to call: ', id);
    setConnectingCall(true);

    // Call a peer, providing our mediaStream
    const inputs = await requestMic();

    if (inputs?.full) {
      const call = peer.call(id, inputs.full, { sdpTransform: requestStereo });
      setCall(call);

      if (call) {
        window.setTimeout(() => {
          if ((call === currentCall.current) && !call.open) {
            console.log('Call timeout, closing');
            setCall(null);
            setConnectingCall(false);
          }
        }, 40000);
      }

      if (!call) {
        setCall(null);
        setConnectingCall(false);
        return;
      }

    } else {
      setConnectingCall(false);
    }
  }, [currentCall, peer, peerID, requestMic]);

  console.log('re-running PeerView...');

  useEffect(() => {
    if (ownMediaStream) {
      return () => {
        if (ownMediaStream) {
          // close tracks to get rid of "tab is using microphone" markers
          const tracks = ownMediaStream.getAudioTracks();
          tracks.forEach((track) => {
            console.log('Force-stopping audio track: ', track);
            track.stop();
          });
        }
        setSynchroStream(null);
      };
    }
  }, [ownMediaStream]);

  const sendPeerCommand = useCallback((id: string, cmd: string) => {
    const conn = peer.connect(id);

    conn?.on('open', () => {
      console.log('sending command', conn, cmd);
      conn.send('up: hello!');
      conn.send(cmd);
      setTimeout(() => {
        conn.close();
        setCmdConnection(null);
      }, 5000);
    });

  }, [peer]);

  useEffect(() => {
    const callClosed = function() {
      console.log('Call closed.');
      setCall(null);
      setConnectingCall(false);
    }
    const callError = function(err: any) {
      console.error('Call error:', err);
      setCall(null);
      setConnectingCall(false);
    };

    if (call) {
      call.on('close', callClosed);
      call.on('error', callError);

      return () => {
        call.close();
        sendPeerCommand(call.peer, '/hangup');

        call.off('close', callClosed);
        call.off('error', callError);
      };
    }
  }, [call, sendPeerCommand]);

  useEffect(() => {
    if (cmdConnection) {
      return () => {
        cmdConnection.close();
      };
    }
  }, [cmdConnection]);

  const closeCall = useCallback(() => {
    if (call) {
      call.close();
      setCall(null);
    }
    if (incomingOffer) {
      sendPeerCommand(incomingOffer.peer, '/hangup');
      incomingOffer.close();
      setIncomingOffer(null);
    }
    setConnectingCall(false);
    setCmdConnection(null);
  }, [call, incomingOffer, sendPeerCommand]);

  useEffect(() => {
    console.log('re-running effect...');

    const peerError = function(err: any) {
      console.error('peer error: ', err);
      setConnectingCall(false);
      currentCall.current?.close();
      setCall(null);
    };
    peer.on('error', peerError);

    const peerOpen = function(id: string) {
      console.log('My *own* peer ID is: ' + id);
      setOwnID(id);
    };
    peer.on('open', peerOpen);

    const peerConnection = function(conn: Peer.DataConnection) {
      setCmdConnection(conn);
      conn.on('data', (data) => {
        console.log('received down:', data);

        if (data === '/hangup' && (
          (currentCall.current && currentCall.current.peer === conn.peer) ||
          (currentOffer.current && currentOffer.current.peer === conn.peer)
        )) {
          closeCall();
        }
      });
      conn.on('open', () => {
        conn.send('hello!');
      });
    };
    peer.on('connection', peerConnection);

    const peerDisconnected = function() {
      console.log(`Peer disconnected event. Disconnected? ${peer.disconnected} Destroyed? ${peer.destroyed}`);
    };
    peer.on('disconnected', peerDisconnected);

    const peerCall = async function(incomingCall: Peer.MediaConnection) {
      console.log('Receiving a call: ', incomingCall);

      setConnectingCall(true);
      setIncomingOffer(incomingCall);
    };
    peer.on('call', peerCall);

    return () => {
      peer.off('error', peerError);
      peer.off('open', peerOpen);
      peer.off('connection', peerConnection);
      peer.off('disconnected', peerDisconnected);
      peer.off('call', peerCall);
      //peer?.destroy();
    };
  }, [peer, selectedMic, requestMic, currentCall, currentOffer, closeCall]);

  useEffect(() => {
    let mounted = true;
    function doCount() {
      let totalCount = _reduce(peer.connections, (accu, connectionArr: any[], peerID: string) => {
        return accu + connectionArr.length;
      }, 0);

      totalCount = Math.max(totalCount, (call ? 1 : 0) + (cmdConnection ? 1 : 0));

      setPeerConnCount(totalCount);

      const peerServerStatus = ''
        + (peer.destroyed ? 'destroyed, ' : '')
        + (peer.disconnected ? 'disconnected, ' : '')
        + (!peer.destroyed && !peer.disconnected ? 'connected, ' : '')
        + (totalCount === 0 ? 'no connections' : 'connections = ' + totalCount);

      setPeerServerStatus(peerServerStatus);

      if (cmdConnection || (totalCount > 0 && (!cmdConnection && !call))) {
        setTimeout(() => {
          // this should go away after a while
          if (mounted) {
            doCount();
          }
        }, 5000);
      }
    }
    doCount();

    return () => {
      mounted = false;
    };
  }, [peer.connections, peer.destroyed, peer.disconnected, call, cmdConnection]);

  const answerCall = async (incomingCall: Peer.MediaConnection) => {
    // Answer the call, providing our mediaStream
    const inputs = await requestMic();

    if (inputs?.full) {
      incomingCall.answer(inputs.full, { sdpTransform: requestStereo });
      setCall(incomingCall);
      setPeerID(incomingCall.peer);
    } else {
      incomingCall.close();
      setCall(null);
      setConnectingCall(false);
    }
  };

  const toggleMic = useCallback(() => {
    if (ownMediaStream) {
      setOwnMediaStream(null);
    } else {
      requestMic();
    }
  }, [ownMediaStream, requestMic]);

  const callIsConnected = useCallback(() => {
    if (call) {
      setConnectingCall(false);
    }
  }, [call]);

  const qrReaderScanned = (code: string | null) => {
    console.log('Reader scanned', code);
    if (code) {
      setPeerID(code);
      toggleShowQRReader(false);
    }
  };

  const handleQRReaderClose = () => {
    toggleShowQRReader(false);
  };

  const callSpinner = connectingCall ? (<>
    <Spinner
      as="span"
      animation="border"
      size="sm"
      role="status"
      aria-hidden="true"
    />
    <span className="sr-only">Loading...</span>
    </>) : null;

  const waitingForUserSpinner = waitingForUser ? (<>
    <Spinner
      animation="border"
      size="sm"
      role="status"
      aria-hidden="true"
    />
    <span>Waiting for approval to use the microphone</span>
    </>) : null;

  let micSelector = null;
  const microphones = useEnumerateMediaDevices(ownMediaStream != null).audioIns;
  if (microphones.length >= 1) {
    const microphoneOptions = microphones.map(item => (
      <option key={item.uuid} value={item.uuid}>{item.label}</option>
    ));

    micSelector = (
      <Form.Group as={Row} controlId="formMicSelect">
        <Form.Label column sm="2">Use microphone</Form.Label>
        <Col sm="10">
          <InputGroup size="sm">
            <Form.Control as="select"
              value={selectedMic || undefined}
              disabled={!!ownMediaStream}
              onChange={(evt) => setSelectedMic(evt.target.value)}>
                  {microphoneOptions}
            </Form.Control>
            <InputGroup.Append>
              <Button variant="info" onClick={toggleMic} disabled={!!ownMediaStream && !!call}>
                {ownMediaStream ? 'close 🔇' : 'open 🎤'}
              </Button>
            </InputGroup.Append>
          </InputGroup>
        </Col>
      </Form.Group>
    );
  } else {
    micSelector = (
      <Row>
        <Col>
          <p className="bg-danger">Microphone inputs not available!</p>
        </Col>
      </Row>
    );
  }

  const callView = call ? (
    <CallView
      call={call}
      audioCtx={audioCtx}
      ownMediaCh0={ownMediaCh0}
      ownMediaCh1={ownMediaCh1}
      callIsConnected={callIsConnected}
    />
  ) : null;

  return (
    <div>
      <Form className="p-2">
        <Form.Group as={Row} controlId="formPeerServer">
          <Form.Label column sm="2">
            Peer server
          </Form.Label>
          <Col sm="10">
            <InputGroup size="sm">
              <Form.Control plaintext readOnly value={peerServerStatus} />
              <InputGroup.Append>
                <Button variant="danger" disabled={peerConnCount === 0} onClick={() => {
                    _forEach(peer.connections, (connArray: any[]) => {
                      connArray.slice(0).forEach(conn => {
                        conn.close();
                      });
                    });
                    forceUpdate();
                }}>Close all</Button>
              </InputGroup.Append>
            </InputGroup>
          </Col>
        </Form.Group>

        <Form.Group as={Row} controlId="formOwnID">
          <Form.Label column sm="2">
            Own ID
          </Form.Label>
          <Col sm="10">
            <InputGroup size="sm">
              <Form.Control plaintext readOnly className="user-select-all" value={ownID || 'initializing'} />
              <InputGroup.Append>
                <Button variant="info" onClick={toggleShowQRCode}>show 🔗</Button>
              </InputGroup.Append>
            </InputGroup>
          </Col>
        </Form.Group>

        {micSelector}

        <Form.Group as={Row} controlId="formConnectTo">
          <Form.Label column sm="2">
            Connect to
          </Form.Label>
          <Col sm="10">
            <InputGroup size="sm">
              <Form.Control
                disabled={!!call}
                placeholder="Enter the peer's ID"
                type="text"
                value={peerID}
                onChange={(event) => setPeerID(event.target.value)} />
              <InputGroup.Append>
                <Button
                  variant="info"
                  onClick={toggleShowQRReader}
                  disabled={!!call}
                >
                  scan 📷
                </Button>
              </InputGroup.Append>
            </InputGroup>
          </Col>
        </Form.Group>

        {(incomingOffer && (
          <>
            <Row>
              <Col className="text-center">
                Pick up call from <strong>{incomingOffer.peer}</strong>
                {callSpinner}
              </Col>
            </Row>
            <Row>
              <Col className="text-center">
                <Button variant="danger" onClick={closeCall}>
                  Hangup
                </Button>
                <Button variant="primary" className="ml-2" onClick={() => {
                  const call = incomingOffer;
                  setIncomingOffer(null);
                  answerCall(call);
                }}>
                  Answer with audio
                </Button>
              </Col>
            </Row>
          </>
        )) || (
            <Row>
              <Col className="text-center">
                {(call && (
                  <Button variant="danger" onClick={closeCall}>
                    Hangup
                  </Button>)) || (
                    <Button variant="primary" disabled={connectingCall} onClick={callPeer}>
                      {callSpinner} Connect with audio
                    </Button>
                  )}
              </Col>
            </Row>
          )}
      </Form>

      {waitingForUserSpinner}

      <Container>
        <Row>
          <Col>
            <AudioStreamVisualizer audioContext={audioCtx} mediaStream={ownMediaCh0} label="Own left" muted={true} />
          </Col>
          <Col>
            <AudioStreamVisualizer audioContext={audioCtx} mediaStream={ownMediaCh1} label="Own right" muted={true} />
          </Col>
        </Row>
      </Container>

      {callView}

      <Modal show={showQRCode} onHide={toggleShowQRCode}>
        <Modal.Header closeButton>
          <Modal.Title>Own id</Modal.Title>
        </Modal.Header>

        <Modal.Body>
          <Container fluid>
            <Row className="justify-content-md-center">
              <Col>
                <QRCode value={ownID || 'initializing'} />
                <hr />
                <p className="user-select-all">{ownID || 'initializing'}</p>
              </Col>
            </Row>
          </Container>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="primary" onClick={toggleShowQRCode}>Close</Button>
        </Modal.Footer>
      </Modal>

      <Modal show={showQRReader} onHide={handleQRReaderClose}>
        <Modal.Header closeButton>
          <Modal.Title>Scan the peer's id</Modal.Title>
        </Modal.Header>

        <Modal.Body>
            <QrReader
              delay={300}
              facingMode={"environment"}
              onError={console.error}
              onScan={qrReaderScanned}
              style={{ width: '100%' }}
            />
            <p>Looking for a QR code</p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="primary" onClick={handleQRReaderClose}>Close</Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

/**
 * Adds a synchronization signal as the "right" channel in a stereo stream.
 */
function addSynchronizerChannel(
      stream: MediaStream,
      audioCtx: AudioContext) {

  if (!audioCtx) {
    console.error('No AudioContext, audio synchronization not possible.');
    return {
      stream: stream,
      stoppables: [] as { stop: () => void }[],
      disconnectables: [] as AudioNode[],
    };
  }

  const SIGNAL_LENGTH = 4;
  const SAMPLE_RATE = audioCtx?.sampleRate || 44100;
  const offlineCtx = new OfflineAudioContext(1, SAMPLE_RATE * SIGNAL_LENGTH, SAMPLE_RATE);

  const origSource = audioCtx.createMediaStreamSource(stream);
  const merger = audioCtx.createChannelMerger(2);
  origSource.connect(merger, 0, 0);

  const dest = audioCtx.createMediaStreamDestination();
  merger.connect(dest);

  makeSynchronizerSignal(offlineCtx);

  let startTime = audioCtx.currentTime + 2;
  let song: AudioBufferSourceNode | null = null;

  offlineCtx.startRendering().then(function(renderedBuffer) {
    console.log('Audio rendering completed successfully');

    song = audioCtx.createBufferSource();
    song.buffer = renderedBuffer;
    song.connect(merger, 0, 1);
    song.loop = true;
    song.start(startTime);

  }).catch(function(err) {
    console.log('Audio rendering failed: ' + err);
  });

  return {
    stream: dest.stream,
    stoppables: [{
      stop: () => {
        if (song !== null) {
          song.stop();
          song.disconnect();
          song = null;
        }
      }
    }] as { stop: () => void }[],
    disconnectables: [origSource, merger] as AudioNode[],
  }
}

function makeSynchronizerSignal(audioCtx: OfflineAudioContext) {
  const freqShape = new Array(4000).fill(0);
  let modulo = 17;
  for (let i = 0; i < freqShape.length; i++) {
    freqShape[i] = modulo / 200 - 1;
    modulo = (modulo + 53) % 400;
  }

  var ft = new DSP.DFT(freqShape.length, 1);
  ft.forward(freqShape);
  const a = new Float32Array(ft.real);
  const b = new Float32Array(ft.imag);
  var lfoTable = audioCtx.createPeriodicWave(a, b);

  const ac = audioCtx;

  const stoppables = [] as AudioScheduledSourceNode[];
  const disconnectables = [] as AudioNode[];

  // create Oscillator nodes
  function makeModulator(
    soundBaseFreq: number,
    baseWaveType: OscillatorType,
    freqModulatorWave: PeriodicWave,
    freqModulatorFreq: number,
    freqModulatorHalfRange: number) {

    // "lfo" modulates the frequency produced by "osc"
    const osc = ac.createOscillator();
    osc.frequency.value = soundBaseFreq;
    osc.type = baseWaveType;
    stoppables.push(osc);
    disconnectables.push(osc);

    const lfo = ac.createOscillator();
    stoppables.push(lfo);
    disconnectables.push(lfo);
    lfo.setPeriodicWave(freqModulatorWave);
    lfo.frequency.value = freqModulatorFreq;

    const lfoGain = ac.createGain();
    disconnectables.push(lfoGain);
    lfoGain.gain.value = freqModulatorHalfRange;

    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    return osc;
  }

  const osc = makeModulator(1040, 'sine', lfoTable, 80 / 4000, 1000);

  const lfoSquare = audioCtx.createOscillator();
  lfoSquare.type = 'square';
  stoppables.push(lfoSquare);
  disconnectables.push(lfoSquare);
  // 1/80 s on, 1/80 s off
  lfoSquare.frequency.value = 40;

  const gainSquare = audioCtx.createGain();
  // gainSquare.gain.value = 1; --default
  // gain will be between 1 + [-1, 1] = [0, 2]
  lfoSquare.connect(gainSquare.gain);

  const startTime = audioCtx.currentTime + 0;

  stoppables.forEach(node => node.start(startTime));

  const gainHalve = audioCtx.createGain();
  gainHalve.gain.value = 0.5;

  osc.connect(gainSquare)
    .connect(gainHalve)
    .connect(audioCtx.destination);
}

export default PeerView;
