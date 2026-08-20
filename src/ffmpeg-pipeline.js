'use strict';

const { spawnProcess } = require('./process-runner');
const { PipelineMetrics } = require('./metrics');
const { EncodedFrameParser } = require('./media/encoded-frame-parser');
const { EncodedFrameHub } = require('./media/encoded-frame-hub');
const { LocalDecoderConsumer } = require('./media/local-decoder-consumer');

function lineReader(stream, onLine) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/[\r\n]+/);
    pending = lines.pop();
    lines.forEach(onLine);
  });
  stream.on('end', () => { if (pending) onLine(pending); });
}

function encoderArgs(target, config) {
  const keyFrameInterval = Math.max(10, Math.round(config.fps / 4));
  return [
    '-hide_banner', '-loglevel', 'info', '-nostdin',
    '-filter_complex',
    `gfxcapture=hwnd=${target.hwnd}:capture_cursor=0:capture_border=0:display_border=0:max_framerate=${config.fps}:width=-2:height=-2,showinfo[captured]`,
    '-map', '[captured]',
    '-an', '-c:v', 'h264_nvenc', '-preset', 'p3', '-tune', 'ull', '-multipass', 'disabled',
    '-profile:v', 'high', '-spatial-aq', '1', '-aq-strength', '8',
    '-rc', 'cbr', '-b:v', config.bitrate, '-maxrate', config.bitrate, '-bufsize', config.bufferSize,
    '-g', String(keyFrameInterval), '-keyint_min', String(keyFrameInterval), '-bf', '0', '-rc-lookahead', '0',
    '-surfaces', '2', '-delay', '0', '-zerolatency', '1', '-strict_gop', '1', '-forced-idr', '1',
    '-aud', '1', '-flush_packets', '1', '-f', 'h264', 'pipe:1',
  ];
}

function decoderArgs(config) {
  const common = [
    '-hide_banner', '-loglevel', 'info', '-stats', '-nostdin',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-probesize', '32', '-analyzeduration', '0',
    '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
    '-f', 'h264', '-framerate', String(config.fps), '-i', 'pipe:0',
  ];
  if (config.previewOutput) {
    const previewFps = Number.isFinite(config.previewFps) ? config.previewFps : 30;
    const previewJpegQuality = Number.isFinite(config.previewJpegQuality) ? config.previewJpegQuality : 5;
    const previewMaxWidth = Number.isFinite(config.previewMaxWidth) ? config.previewMaxWidth : 960;
    return [
      ...common,
      '-vf', `hwdownload,format=nv12,format=yuv420p,showinfo,fps=${previewFps},scale=w='min(${previewMaxWidth},iw)':h=-2:flags=lanczos`,
      '-an', '-c:v', 'mjpeg', '-q:v', String(previewJpegQuality), '-f', 'image2pipe', 'pipe:1',
    ];
  }
  return [
    ...common,
    '-vf', 'hwdownload,format=nv12,format=yuv420p,showinfo', '-an', '-pix_fmt', 'yuv420p',
    '-f', 'sdl2', '-window_title', `Phase 1 decoded preview - PID ${config.pid}`,
    `Phase 1 decoded preview - PID ${config.pid}`,
  ];
}

class FfmpegPipeline {
  constructor(target, config) {
    this.target = target;
    this.config = config;
    this.metrics = new PipelineMetrics(config.metricsIntervalMs);
    this.stopping = false;
    this.captureFrameSeen = -1;
    this.decodeFrameSeen = -1;
    this.captureTimestamps = [];
    this.encodedFrames = new EncodedFrameHub();
  }

  addEncodedConsumer(consumer) { return this.encodedFrames.addConsumer(consumer); }

  start() {
    const ffmpeg = this.config.ffmpegPath || 'ffmpeg.exe';
    const mediaConfig = {
      ...this.config,
      pid: this.target.pid,
      outputWidth: this.target.captureWidth + (this.target.captureWidth % 2),
      outputHeight: this.target.captureHeight + (this.target.captureHeight % 2),
    };
    this.decoder = spawnProcess(ffmpeg, decoderArgs(mediaConfig));
    this.encoder = spawnProcess(ffmpeg, encoderArgs(this.target, this.config));
    this.localDecoder = new LocalDecoderConsumer(this.decoder.stdin, {
      maxQueueDepth: 2,
      onDrop: () => { this.metrics.decodeDrops += 1; },
      onBackpressure: () => this.metrics.backpressure(),
    });
    this.addEncodedConsumer(this.localDecoder);
    if (this.config.previewOutput) {
      this.decoder.stdout.pipe(this.config.previewOutput, { end: false });
      this.config.previewOutput.on('error', (error) => {
        if (!this.stopping) this.fail(`Embedded preview pipe failed: ${error.message}`);
      });
    }
    this.parser = new EncodedFrameParser({
      width: mediaConfig.outputWidth,
      height: mediaConfig.outputHeight,
      timestampSource: () => this.captureTimestamps.shift(),
      onConfig: (config) => this.encodedFrames.publishConfig(config),
      onFrame: (frame) => {
        this.metrics.encoded(frame.encodeCompleteTimestamp);
        this.encodedFrames.publish(frame);
        this.metrics.maxDecoderQueue = Math.max(this.metrics.maxDecoderQueue, this.localDecoder.queueDepth);
        this.metrics.maybeReport(frame.encodeCompleteTimestamp);
      },
    });

    this.encoder.stdout.on('data', (chunk) => this.parser.push(chunk));
    this.encoder.stdout.on('end', () => {
      this.parser.flush();
      this.encodedFrames.end();
    });

    const capturePattern = /Parsed_showinfo[^\]]*\].*\bn:\s*(\d+)/;
    lineReader(this.encoder.stderr, (line) => {
      const match = line.match(capturePattern);
      if (match) {
        const frame = Number(match[1]);
        while (this.captureFrameSeen < frame) {
          this.captureFrameSeen += 1;
          const captureTimestamp = process.hrtime.bigint();
          this.metrics.captured(captureTimestamp);
          this.captureTimestamps.push(captureTimestamp);
          while (this.captureTimestamps.length > 4) {
            this.captureTimestamps.shift();
            this.metrics.correlationMisses += 1;
          }
        }
      } else if (/\bdrop=\s*\d+/.test(line)) {
        const dropMatch = line.match(/\bdrop=\s*(\d+)/);
        this.metrics.captureDrops = Math.max(this.metrics.captureDrops, Number(dropMatch[1]));
      } else if (/\b(error|failed?|invalid|unsupported|cannot|could not|no capable devices)\b/i.test(line)) {
        console.error(`[encoder] ${line}`);
      }
    });

    lineReader(this.decoder.stderr, (line) => {
      const match = line.match(capturePattern);
      if (match) {
        const frame = Number(match[1]);
        while (this.decodeFrameSeen < frame) {
          this.decodeFrameSeen += 1;
          this.metrics.decoded();
        }
      } else if (/\bfd=\s*\d+/.test(line)) {
        const dropMatch = line.match(/\bfd=\s*(\d+)/);
        this.metrics.decodeDrops = Math.max(this.metrics.decodeDrops, Number(dropMatch[1]));
      } else if (/\b(error|failed?|invalid|unsupported|cannot|could not|no device)\b/i.test(line)) {
        console.error(`[decoder] ${line}`);
      }
    });
    this.encoder.on('error', (error) => this.fail(`Encoder could not start: ${error.message}`));
    this.decoder.on('error', (error) => this.fail(`Decoder could not start: ${error.message}`));
    this.decoder.stdin.on('error', (error) => { if (!this.stopping) this.fail(`Encoded stream pipe failed: ${error.message}`); });
    this.encoder.on('close', (code) => {
      if (!this.stopping && code !== 0) this.fail(`Capture/encoder exited with code ${code}. Check the diagnostic above.`);
    });
    this.decoder.on('close', (code) => {
      if (!this.stopping && code !== 0) this.fail(`Decoder exited with code ${code}.`);
    });
  }

  fail(message) {
    if (this.stopping) return;
    console.error(`\n${message}`);
    this.stop();
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 250).unref();
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    for (const child of [this.encoder, this.decoder]) {
      if (child && !child.killed) child.kill();
    }
  }
}

module.exports = { FfmpegPipeline, encoderArgs, decoderArgs };
