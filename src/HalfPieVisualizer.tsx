import React from 'react';
import _memoize from 'lodash/memoize';
import _range from 'lodash/range';

import './HalfPieVisualizer.css';

interface HalfPieVisualizerProps {
  data: number[] | Float64Array,
  dataToColor: (item: number) => string,
  dataToSize: (item: number) => number,
  reverse?: boolean,
}

export default class HalfPieVisualizer
  extends React.PureComponent<HalfPieVisualizerProps> {

  static graphBase = (() => {
    const angledLength = 8;
    const angledLines = [15, 30, 45, 60, 75].map(angle => {
      const rads = angle / 180 * Math.PI;
      const x = Math.sin(rads) * angledLength;
      const y = -Math.cos(rads) * angledLength;
      return `M -${x},${y} L 0,0 ${x},${y}`;
    }).join(' ');
    return (
      <>
        <path key="basemain" className="base-major" fill="none" d=
          "M 0,0 L 0,-8 M -8,0 L 8,0 "
        />
        <path key="base" className="base-minor" fill="none" d={
          angledLines
        }
        />
      </>);
  })();

  cacheBins: (n: number, reverse: boolean) => string[];

  constructor(props: HalfPieVisualizerProps) {
    super(props);
    this.cacheBins = _memoize(this.createBins, (n, rev) => rev? -n : n);
  }

  createBins(n: number, reverse: boolean) {
    console.log('Calculating bins: ', n);
    const startAngle = -90, endAngle = 90;
    const emptyPerSlice = 0.2;
    // full opening [startAngle, endAngle] contains num_of_bins arcs and (num_of_bins-1) gaps
    // gap = e*arc
    // full = n*arc+(n-1)*gap = n*arc + (n-1)*e*arc
    // arc = full/(n+(n-1)*e)
    const drawWidth = (endAngle - startAngle) / (n + (n - 1) * emptyPerSlice);
    const binWidth = drawWidth + emptyPerSlice * drawWidth;
    const emptyPerSide = 0;

    const arcs = _range(n).map((i) => {
      const angle = startAngle + i * binWidth;
      const d = arcToSVGCommands(0, 0, 8, angle + emptyPerSide, angle + drawWidth + emptyPerSide);
      return d;
    });
    if (reverse) {
      return arcs.reverse();
    } else {
      return arcs;
    }
  }

  createColors(data: number[] | Float64Array) {
    // cannot map directly from Float64Array to string[]
    const r = Array<string>(data.length);
    data.forEach((val: number, i: number) => {
      r[i] = this.props.dataToColor(val);
    })
    return r;
  }

  createSizes(data: number[] | Float64Array) {
    return data.map(this.props.dataToSize);
  }

  render() {
    const bins = this.cacheBins(this.props.data.length, this.props.reverse || false);
    const colors = this.createColors(this.props.data);
    const sizes = this.createSizes(this.props.data);

    // viewBox min-x, min-y, width, height
    return (
      <svg className="HalfPie" viewBox="-10 -10 20 10" xmlns="http://www.w3.org/2000/svg">
        {HalfPieVisualizer.graphBase}
        {bins.map((d, i) =>
          <path key={i} fill="none" stroke={colors[i]} strokeWidth={sizes[i]} d={d} />)}
      </svg>
    );
  }
}

/**
 * Calculates the coordinates of a point on a circle.
 */
function polarToCartesian(centerX: number, centerY: number, r: number, angleInDegrees: number) {
  var angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;

  return {
    x: centerX + (r * Math.cos(angleInRadians)),
    y: centerY + (r * Math.sin(angleInRadians))
  };
}

/**
 * Returns the suitable path commands ("d attribute") for an SVG
 * path element representing an arc.
 */
function arcToSVGCommands(x: number, y: number, radius: number, startAngle: number, endAngle: number) {
  // start and end points
  const s = polarToCartesian(x, y, radius, endAngle);
  const e = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return `M ${s.x},${s.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${e.x},${e.y}`;
}
