import { useEffect, useRef, useState } from "react";

import Button from 'react-bootstrap/Button'
import Col from 'react-bootstrap/Col'
import Container from 'react-bootstrap/Container';
import Form from 'react-bootstrap/Form';
import InputGroup from 'react-bootstrap/InputGroup';
import Row from 'react-bootstrap/Row';

import { useFullscreen, useToggle } from 'react-use';

import { analyseCorrelationSignal } from "./TimeshiftCanvas";
import HalfPieVisualizer from './HalfPieVisualizer';

import _clamp from 'lodash/clamp';

import './TimeshiftSvgVisualizer.css';

interface TimeshiftSvgVisualizerProps {
  data: number[],
  width: number,
  height: number,
  peakIndex?: number, // = [-n/2, n/2[
  peakWidth?: number,
  analysis?: ReturnType<typeof analyseCorrelationSignal>,
  sampleRate: number,
}
export default function TimeshiftSvgVisualizer(props: TimeshiftSvgVisualizerProps) {
  const [dataView, setDataView] = useState<number[]>([]);
  const [micDist, setMicDist] = useState<number>(0.4);
  const [orientRight, toggleOrientRight] = useToggle(true);
  const [angleIndices, setAngleIndices] = useState<number[]>([]);
  const [maxVal, setMaxVal] = useState<number>(0);

  const fullscreenRef = useRef<HTMLDivElement>(null);
  const [showFullscreen, toggleFullscreen] = useToggle(false);
  /*const isFullscreen =*/
  useFullscreen(
    fullscreenRef,
    showFullscreen, { onClose: () => toggleFullscreen(false) });

  const sampleRate = props.sampleRate;

  useEffect(() => {
    setAngleIndices(calcTimeshiftsForAngles(micDist, 0, 180));
  }, [micDist]);

  useEffect(() => {
    const propsData = props.data;
    const size = 91;

    const data = Array(size);
    let maxVal = 0;

    function sampleFrom(from: number) {
      const f = Math.floor(from);
      const t = Math.min(Math.ceil(from), propsData.length - 1);
      const sample = (propsData[f] + propsData[t]) / 2;
      return (sample + 1) / 2;
    }

    let val;
    for (let i = 0; i < size; i++) {
      const angle = Math.floor(i / (size - 1) * 180);
      const timediff = angleIndices[angle];
      let from;
      if (timediff < 0) {
        from = timediff * sampleRate + propsData.length;
      } else {
        from = timediff * sampleRate;
      }

      val = sampleFrom(from);
      data[size - 1 - i] = val;
      maxVal = Math.max(maxVal, val);
    }

    setDataView(data);
    setMaxVal(maxVal);
  }, [props.data, angleIndices, sampleRate]);

  const ownName = 'own';
  const peerName = 'peer';

  return (
    <Container fluid className="p-0">
      <Row noGutters={true}>
        <Col>
          <div className="TimeshiftSVG"
            ref={fullscreenRef}
            onClick={toggleFullscreen}
          >
            <HalfPieVisualizer
              data={dataView}
              dataToColor={(item: number) => `rgb(${Number.isNaN(item) ? 0 : Math.round(_clamp((item - 0.4) * 5 * 255, 0, 255))}, 0, 0)`}
              dataToSize={(item: number) => (item === maxVal ? 2 : 1)}
              reverse={!orientRight}
            />
          </div>
        </Col>
      </Row>

      <Form.Group as={Row} controlId="formMicDist">
        <Col>
          <InputGroup size="sm">
            <InputGroup.Prepend>
              <Button variant={orientRight ? "primary" : "secondary"} onClick={toggleOrientRight}>
                {'🎤 ' + (orientRight ? ownName : peerName)}
              </Button>
            </InputGroup.Prepend>

            <Form.Control
              type="number"
              step={0.01}
              value={micDist}
              onChange={(event) => setMicDist(+event.target.value)} />

            <InputGroup.Append>
              <Button variant={orientRight ?  "secondary": "primary"} onClick={toggleOrientRight}>
                {(orientRight ? peerName : ownName) + ' 🎤'}
              </Button>
            </InputGroup.Append>
          </InputGroup>

          <Form.Label>
            Distance between microphones (m)
            </Form.Label>
        </Col>
      </Form.Group>

    </Container>
  );
}

/*
 * Formulas for calculating the time difference.
 * Maxima:
 * subst([l1=sqrt(x^2+y^2), l2=sqrt((x+d)^2+y^2)], m=l1-l2);
 * (phi is calculated from the corner)
 * or: subst([l1=sqrt((x-d2)^2+y^2), l2=sqrt((x+d2)^2+y^2)], m=l1-l2);
 *     (d2 = d/2; phi is calculated from the middle of the two points)
 * subst([x=s*cos(phi), y=s*sin(phi)], %);
 * Result:
 * m=sqrt(sin(phi)^2*s^2+cos(phi)^2*s^2)-sqrt((cos(phi)*s+d)^2+sin(phi)^2*s^2)
 * or: m=sqrt((cos(phi)*s-d2)^2+sin(phi)^2*s^2)-sqrt((cos(phi)*s+d2)^2+sin(phi)^2*s^2)
 *
 * m:   difference in observation (same unit as s and d, so meters or seconds)
 * phi: angle (0 = in line with the two microphones, on this mic's side, pi/2 = perpendicular)
 * s:   length of the hypotenuse, i.e. how far the sound source is expected to be
 *          --- s should be much bigger than d to approximate distant sources
 * d:   distance between the microphones
 *
 * Plotting:
 * load("draw");
 * #subst([d=0.4, phi=%pi/4], %o82);
 * #wxdraw2d(implicit(%o83, s, 0.1, 8, m, -0.5, 0.2));
 *
 * mval: m=sqrt(sin(phi)^2*s^2+cos(phi)^2*s^2)-sqrt((cos(phi)*s+d)^2+sin(phi)^2*s^2);
 * wxdraw2d(
        key="phi=0", color=green,
        implicit(subst([d=0.4, phi=0], mval), s, 0.1, 8, m, -0.5, 0.5),
        key="phi=1/8 Ï€", color=red,
        implicit(subst([d=0.4, phi=1*%pi/8], mval), s, 0.1, 8, m, -0.5, 0.5),
        key="phi=2/8 Ï€",
        implicit(subst([d=0.4, phi=2*%pi/8], mval), s, 0.1, 8, m, -0.5, 0.5),
        key="phi=3/8 Ï€",
        implicit(subst([d=0.4, phi=3*%pi/8], mval), s, 0.1, 8, m, -0.5, 0.5),
        key="phi=4/8 Ï€",
        implicit(subst([d=0.4, phi=4*%pi/8], mval), s, 0.1, 8, m, -0.5, 0.5),
        key="phi=5/8 Ï€",
        implicit(subst([d=0.4, phi=5*%pi/8], mval), s, 0.1, 8, m, -0.5, 0.5),
        key="phi=6/8 Ï€",
        implicit(subst([d=0.4, phi=6*%pi/8], mval), s, 0.1, 8, m, -0.5, 0.5),
        key="phi=7/8 Ï€",
        implicit(subst([d=0.4, phi=7*%pi/8], mval), s, 0.1, 8, m, -0.5, 0.5),
        key="phi=Ï€", color=cyan,
        implicit(subst([d=0.4, phi=8*%pi/8], mval), s, 0.1, 8, m, -0.5, 0.5),
        key="phi=9/8 Ï€", color=blue,
        implicit(subst([d=0.4, phi=9*%pi/8], mval), s, 0.1, 8, m, -0.5, 0.5),
        key="phi=10/8 Ï€",
        implicit(subst([d=0.4, phi=10*%pi/8], mval), s, 0.1, 8, m, -0.5, 0.5)
    );
 *
 */

function calcTimeshiftsForAngles(micDistMeters: number, from: number, to: number) {
  const SPEED_OF_SOUND = 343; // m/s
  const d = micDistMeters / SPEED_OF_SOUND; // s
  const d2 = d/2;
  const sqrt = Math.sqrt, sin = Math.sin, cos = Math.cos;
  const s = 10 * d;
  // m=sqrt((cos(phi)*s-d2)^2+sin(phi)^2*s^2)-sqrt((cos(phi)*s+d2)^2+sin(phi)^2*s^2)
  return new Array(to - from + 1).fill(0).map((_, i) => {
    const phi = i / 180 * Math.PI;
    const sinphi = sin(phi), cosphi = cos(phi);
    return (
      sqrt((cosphi * s - d2) * (cosphi * s - d2) + sinphi * sinphi * s * s)
      - sqrt((cosphi * s + d2) * (cosphi * s + d2) + sinphi * sinphi * s * s));
  });
}
