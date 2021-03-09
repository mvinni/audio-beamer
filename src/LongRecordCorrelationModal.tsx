import { useEffect, useState } from 'react';

import Button from 'react-bootstrap/Button';
import Col from 'react-bootstrap/Col';
import Container from 'react-bootstrap/Container';
import Modal from 'react-bootstrap/Modal';
import Row from 'react-bootstrap/Row';

import { CircularProgressbarWithChildren } from 'react-circular-progressbar';
import { analyseCorrelationSignal, TimeshiftCanvas } from './TimeshiftCanvas';

interface LongRecordCorrelationModalProps {
  recording: boolean,
  processing: boolean,
  result: number,
  timeShiftGraphData: number[] | null,
  onClose: () => void,
  onApplyOffset: (offset: number) => void,
  sampleURL1: string | null,
  sampleURL2: string | null,
}
export default function LongRecordCorrelationModal(props: LongRecordCorrelationModalProps) {
  const [applyPossible, setApplyPossible] = useState<boolean>(true);
  const [offsetText, setOffsetText] = useState<string>('');
  const [analysed, setAnalysed] = useState<ReturnType<typeof analyseCorrelationSignal>>();
  const [percentage, setPercentage] = useState<number>(0);

  useEffect(() => {
    if (props.timeShiftGraphData) {
      setAnalysed(analyseCorrelationSignal(
        props.timeShiftGraphData, props.result, 0.8, 0.0002 * 16000));
    }
  }, [props.timeShiftGraphData, props.result]);

  useEffect(() => {
    if (Number.isNaN(props.result)) {
      setOffsetText('');
      setApplyPossible(false);
    } else {
      setOffsetText((props.result / 16000).toFixed(5) + 's');
      setApplyPossible(true);
      setPercentage(100);
    }
  }, [props.result]);

  useEffect(() => {
    if (!props.recording && !props.processing && !Number.isNaN(props.result)) {
      setPercentage(100);
    } else if (props.processing) {
      setPercentage(75);
    } else {

      let isMounted = true;
      let counter = 0;
      const intervalID = setInterval(() => {
        counter = Math.min(counter + 10, 70);
        if (isMounted) {
          setPercentage(counter);
        } else {
          clearInterval(intervalID);
        }
      }, 1000);

      return () => {
        isMounted = false;
      }

    }
  }, [props.recording, props.processing, props.result]);


  const applyOffset = () => {
    props.onApplyOffset(props.result / 16000);
  };

  const graphEdge = ((props.timeShiftGraphData?.length || 0) / 2 / 16000).toFixed(3);

  const statusMsg = props.recording ? 'Recording' : (
    props.processing ? 'Processing' : 'Ready'
  );
  const resultMsg = offsetText.length ? (`${props.result.toFixed(2)} (${offsetText})`) : '';

  return (
    <Modal show={true} onHide={props.onClose}>
      <Modal.Header closeButton>
        <Modal.Title>Looking for correlation</Modal.Title>
      </Modal.Header>

      <Modal.Body>
        <Container fluid>
          <Row className="justify-content-md-center">
            <Col sm={6}>
              <CircularProgressbarWithChildren value={percentage}>
                <p><strong>{statusMsg}</strong></p>
                <p><strong>{resultMsg}</strong></p>
              </CircularProgressbarWithChildren>
            </Col>
          </Row>
          {props.sampleURL1 && props.sampleURL2 && (
            <Row className="justify-content-md-center">
              <Col>
                <p>Recording 1: <audio src={props.sampleURL1} controls /></p>
                <p>Recording 2: <audio src={props.sampleURL2} controls /></p>
              </Col>
            </Row>
          )}

          {props.timeShiftGraphData && (
            <Row className="justify-content-md-center">
              <Col>
                <TimeshiftCanvas
                  data={props.timeShiftGraphData} width={600} height={200}
                  peakIndex={props.result}
                  analysis={analysed}
                  // this many samples (on either side) can be above the threshold
                  peakWidth={0.0003 * 16000}
                  labels={[`-${graphEdge}s`, '0', `${graphEdge}s`]}
                />
              </Col>
            </Row>
          )}

        </Container>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="primary" onClick={applyOffset} disabled={!applyPossible}>
          Apply time shift {offsetText}
        </Button>
        <Button variant="secondary" onClick={props.onClose}>Close</Button>
      </Modal.Footer>
    </Modal>
  );
}
