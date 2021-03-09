import { useEffect, useRef } from 'react';

import Col from 'react-bootstrap/Col';
import Container from 'react-bootstrap/Container';
import Row from 'react-bootstrap/Row';

function make_smooth_of_n_fn(size :number) {
  let first = true;
  let accu = 0;

  return (n: number) => {
    if (Number.isNaN(n)) {
      return n;
    }
    if (first) {
      first = false;
      accu = n;
      return n;
    } else {
      accu = (n + (size-1)*accu)/size;
      return accu;
    }
  }
}

const avg_smoother = make_smooth_of_n_fn(100);

export function analyseCorrelationSignal(
      data: number[], peakIndex: number,
      peakThreshold: number, peakWidth: number) {

  let minValue = Number.MAX_VALUE;
  let maxValue = -minValue;
  let sum = 0;
  const l = data.length;
  for (let i = 0; i < l; i++) {
    if (data[i] > maxValue) {
      maxValue = data[i];
    }
    if (data[i] < minValue) {
      minValue = data[i];
    }
    sum = sum + data[i];
  }
  const average = avg_smoother(sum/l);

  // scale to value range, keeping the average value in the middle
  if (maxValue-average > average-minValue) {
    minValue = average - (maxValue-average);
  } else {
    maxValue = average + (average-minValue);
  }
  if (minValue === maxValue) {
    minValue = minValue * 0.999999999;
    maxValue = maxValue * 1.000000001 + 0.00000000001;
  }

  const peakThresholdUp = (maxValue - minValue) * peakThreshold + minValue;
  const peakThresholdDown = maxValue - (maxValue - minValue) * peakThreshold;

  const wrappedPeak = (peakIndex < 0) ? peakIndex + data.length : peakIndex;
  const isValidPeak =
    (data[wrappedPeak] > peakThresholdUp || data[wrappedPeak] < peakThresholdDown)
    && data.every((v, i) => {
      if (Math.abs(wrappedPeak - i) < peakWidth) {
        return true;
      }
      // potentially wrapped around 0 at both ends
      if ((data.length - Math.abs(i - wrappedPeak)) < peakWidth) {
        return true;
      }

      return (v < peakThresholdUp && v > peakThresholdDown);
    });

  return {
    min: minValue,
    max: maxValue,
    peakThreshold: peakThresholdUp,
    peakThresholdDown: peakThresholdDown,
    isValidPeak,
  };
}

interface TimeshiftCanvasProps {
  data: number[],
  width: number,
  height: number,
  // experimental/arbitrary threshold values for peak detection
  peakIndex?: number, // = [-n/2, n/2[
  // this many samples (on either side) can be above the threshold
  peakWidth?: number, // e.g. 0.0002 * SAMPLE_RATE
  analysis?: ReturnType<typeof analyseCorrelationSignal>,
  /** three labels to show under the canvas [left_corner, center, right_corner] */
  labels?: string[],
  minDraw?: number,
  maxDraw?: number,
}
export function TimeshiftCanvas(props: TimeshiftCanvasProps) {
  const timeshiftCanvasRef = useRef<HTMLCanvasElement>(null);

  const { minDraw = 0, maxDraw = props.data.length } = props;

  useEffect(() => {
    if (!timeshiftCanvasRef.current) {
      return;
    }
    const canvas = timeshiftCanvasRef.current;
    const WIDTH = canvas.width;
    const HEIGHT = canvas.height;
    const canvasCtx = canvas.getContext("2d");
    if (!canvasCtx) {
      return;
    }

    canvasCtx.fillStyle = 'rgb(200, 200, 200)';
    canvasCtx.fillRect(0, 0, WIDTH, HEIGHT);
    canvasCtx.lineWidth = 2;

    canvasCtx.strokeStyle = 'rgb(0, 0, 0)';
    canvasCtx.beginPath();

    const data = props.data;
    const drawLength = maxDraw - minDraw;
    const sliceWidth = WIDTH * 1.0 / (drawLength || 1);
    let x = 0;

    // data values should be within [0, 1]
    const minValue = props.analysis?.min || 0;
    const maxValue = props.analysis?.max || 1;

    const scaler = ((minValue===1) ? 1 : 1/(maxValue-minValue)) * HEIGHT;
    const n = data.length;

    for (let i = minDraw; i < maxDraw; i++) {
      // reverse: imax = imax < n / 2 ? imax : imax - n;
      // render from -n/2 to n/2
      const dataInd = (i < n / 2) ? i + n / 2 : i - n / 2;
      let y = (data[dataInd] - minValue) * scaler;

      if (i === minDraw) {
        canvasCtx.moveTo(x, HEIGHT - y);
      } else {
        canvasCtx.lineTo(x, HEIGHT - y);
      }

      x += sliceWidth;
    }

    canvasCtx.stroke();

    canvasCtx.fillStyle = 'rgb(0, 0, 0)';
    canvasCtx.font = "24px Arial";
    canvasCtx.fillText('min ' + minValue + ' max ' + maxValue, 0, HEIGHT);

    if (props.peakIndex !== undefined && props.analysis && props.peakWidth) {
      let y = (props.analysis.peakThreshold - minValue) * scaler;
      let y2 = (props.analysis.peakThresholdDown - minValue) * scaler;

      canvasCtx.lineWidth = 2;
      canvasCtx.strokeStyle = 'rgb(0, 255, 0)';
      canvasCtx.beginPath();

      // -n/2 --> 0
      // n/2 --> x=WIDTH-1
      x = (props.peakIndex - minDraw - props.peakWidth + n / 2) / drawLength * WIDTH;
      if (x > 0) {
        canvasCtx.moveTo(0, HEIGHT-y);
        canvasCtx.lineTo(x, HEIGHT-y);
        canvasCtx.moveTo(0, HEIGHT-y2);
        canvasCtx.lineTo(x, HEIGHT-y2);
      }
      x = (props.peakIndex - minDraw + props.peakWidth + n / 2) / drawLength * WIDTH;
      if (x < WIDTH) {
        canvasCtx.moveTo(x, HEIGHT-y);
        canvasCtx.lineTo(WIDTH-1, HEIGHT-y);
        canvasCtx.moveTo(x, HEIGHT-y2);
        canvasCtx.lineTo(WIDTH-1, HEIGHT-y2);
      }

      canvasCtx.stroke();

      // vertical line at the peak
      x = (props.peakIndex - minDraw + n / 2) / drawLength * WIDTH;
      canvasCtx.moveTo(x, 0);
      canvasCtx.lineTo(x, HEIGHT-1);
      canvasCtx.stroke();
    }
  }, [props.data, props.analysis, props.peakIndex, props.peakWidth,
    timeshiftCanvasRef, minDraw, maxDraw]);

  if (props.labels) {
    return (
      <Container fluid className="p-0">
        <Row noGutters={true}>
          <Col>
            <canvas className="timeshift-canvas" ref={timeshiftCanvasRef}
              width={props.width} height={props.height} />
          </Col>
        </Row>
        <Row noGutters={true}>
          <Col>
            <div className="text-left">{props.labels[0]}</div>
          </Col>
          <Col>
            <div className="text-center">{props.labels[1]}</div>
          </Col>
          <Col>
            <div className="text-right">{props.labels[2]}</div>
          </Col>
        </Row>
      </Container>
    );
  } else {
    return <canvas className="timeshift-canvas" ref={timeshiftCanvasRef}
          width={props.width} height={props.height} />;
  }
}
