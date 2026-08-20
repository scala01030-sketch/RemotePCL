'use strict';

class PipelineMetrics {
  constructor(reportIntervalMs = 2000) {
    this.startedNs = process.hrtime.bigint();
    this.lastReportNs = this.startedNs;
    this.reportIntervalMs = reportIntervalMs;
    this.captureTimes = [];
    this.encodedTimes = [];
    this.decodedTimes = [];
    this.encodeLatenciesMs = [];
    this.decodeLatenciesMs = [];
    this.pipelineLatenciesMs = [];
    this.captureQueue = [];
    this.encodedQueue = [];
    this.captureCount = 0;
    this.encodedCount = 0;
    this.decodedCount = 0;
    this.captureDrops = 0;
    this.decodeDrops = 0;
    this.correlationMisses = 0;
    this.maxEncoderQueue = 0;
    this.maxDecoderQueue = 0;
    this.backpressureEvents = 0;
  }

  static msBetween(startNs, endNs) { return Number(endNs - startNs) / 1e6; }

  captured(nowNs = process.hrtime.bigint()) {
    this.captureCount += 1;
    this.captureTimes.push(nowNs);
    this.captureQueue.push({ id: this.captureCount, captureNs: nowNs });
    // One pending frame is useful; discard stale bookkeeping exactly like the intended media policy.
    while (this.captureQueue.length > 2) {
      this.captureQueue.shift();
      this.correlationMisses += 1;
    }
    this.maxEncoderQueue = Math.max(this.maxEncoderQueue, this.captureQueue.length);
  }

  encoded(nowNs = process.hrtime.bigint()) {
    this.encodedCount += 1;
    const frame = this.captureQueue.shift() || { id: this.encodedCount, captureNs: nowNs };
    frame.encodedNs = nowNs;
    this.encodeLatenciesMs.push(PipelineMetrics.msBetween(frame.captureNs, nowNs));
    this.encodedQueue.push(frame);
    while (this.encodedQueue.length > 2) {
      this.encodedQueue.shift();
      this.correlationMisses += 1;
    }
    this.encodedTimes.push(nowNs);
    this.maxDecoderQueue = Math.max(this.maxDecoderQueue, this.encodedQueue.length);
  }

  decoded(nowNs = process.hrtime.bigint()) {
    this.decodedCount += 1;
    const frame = this.encodedQueue.shift();
    if (frame) {
      this.decodeLatenciesMs.push(PipelineMetrics.msBetween(frame.encodedNs, nowNs));
      this.pipelineLatenciesMs.push(PipelineMetrics.msBetween(frame.captureNs, nowNs));
    }
    this.decodedTimes.push(nowNs);
  }

  backpressure() { this.backpressureEvents += 1; }

  fps(times, nowNs) {
    const cutoff = nowNs - 2_000_000_000n;
    while (times.length && times[0] < cutoff) times.shift();
    if (times.length < 2) return 0;
    return (times.length - 1) * 1e9 / Number(times[times.length - 1] - times[0]);
  }

  average(values) {
    if (!values.length) return 0;
    const recent = values.slice(-120);
    return recent.reduce((sum, value) => sum + value, 0) / recent.length;
  }

  maybeReport(nowNs = process.hrtime.bigint()) {
    if (PipelineMetrics.msBetween(this.lastReportNs, nowNs) < this.reportIntervalMs) return;
    this.lastReportNs = nowNs;
    console.log([
      '',
      `Capture: ${this.fps(this.captureTimes, nowNs).toFixed(1)} FPS  Encode: ${this.fps(this.encodedTimes, nowNs).toFixed(1)} FPS  Decode: ${this.fps(this.decodedTimes, nowNs).toFixed(1)} FPS`,
      `Encode avg*: ${this.average(this.encodeLatenciesMs).toFixed(1)} ms  Decode avg*: ${this.average(this.decodeLatenciesMs).toFixed(1)} ms  Pipeline*: ${this.average(this.pipelineLatenciesMs).toFixed(1)} ms`,
      `Dropped: capture=${this.captureDrops} decode=${this.decodeDrops}  Queues max: enc=${this.maxEncoderQueue} dec=${this.maxDecoderQueue}`,
      `Metric correlation misses: ${this.correlationMisses}  Pipe backpressure events: ${this.backpressureEvents}`,
      '* Stage timing is an external-process approximation measured at FFmpeg filter/AUD/decode boundaries.',
    ].join('\n'));
  }
}

module.exports = { PipelineMetrics };
