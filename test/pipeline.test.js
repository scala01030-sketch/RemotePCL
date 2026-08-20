'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PipelineMetrics } = require('../src/metrics');
const { encoderArgs, decoderArgs } = require('../src/ffmpeg-pipeline');
const { EncodedFrameParser } = require('../src/media/encoded-frame-parser');
const { EncodedFrameHub } = require('../src/media/encoded-frame-hub');

test('Annex B parser emits stable EncodedFrame and explicit SPS/PPS config', () => {
  const frames = [];
  const configs = [];
  const origin = process.hrtime.bigint();
  const timestamps = [origin + 1n, origin + 2n];
  const parser = new EncodedFrameParser({
    width: 1920,
    height: 1080,
    timestampSource: () => timestamps.shift(),
    onFrame: (frame) => frames.push(frame),
    onConfig: (config) => configs.push(config),
  });
  const start = [0, 0, 0, 1];
  const key = Buffer.from([...start, 9, 0xf0, ...start, 0x67, 1, 2, ...start, 0x68, 3, ...start, 0x65, 4]);
  const delta = Buffer.from([...start, 9, 0xf0, ...start, 0x41, 5]);
  const next = Buffer.from([...start, 9, 0xf0, ...start, 0x41, 6]);
  parser.push(Buffer.concat([key, delta, next]), origin + 10n);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].frameId, 1n);
  assert.equal(frames[0].codec, 'H264');
  assert.equal(frames[0].width, 1920);
  assert.equal(frames[0].height, 1080);
  assert.equal(frames[0].keyFrame, true);
  assert.ok(Buffer.isBuffer(frames[0].data));
  assert.equal(frames[1].keyFrame, false);
  assert.equal(configs.length, 1);
  assert.equal(configs[0].streamFormat, 'ANNEX_B');
  assert.ok(configs[0].sps.length && configs[0].pps.length);
});

test('EncodedFrameHub supports independent multiple consumers', () => {
  const hub = new EncodedFrameHub();
  const receivedA = [];
  const receivedB = [];
  hub.addConsumer({ consume: (frame) => receivedA.push(frame) });
  hub.addConsumer({ consume: (frame) => receivedB.push(frame) });
  const frame = Object.freeze({ frameId: 7n, data: Buffer.from([1]) });
  hub.publish(frame);
  assert.equal(receivedA[0], frame);
  assert.equal(receivedB[0], frame);
});

test('encoder is locked to exact HWND and NVENC low latency H.264', () => {
  const args = encoderArgs({ hwnd: '4660' }, { fps: 60, bitrate: '12M', bufferSize: '4M' });
  assert.ok(args.some((arg) => arg.includes('gfxcapture=hwnd=4660')));
  assert.ok(args.some((arg) => arg.includes('capture_cursor=0')));
  assert.equal(args.includes('gdigrab'), false);
  assert.ok(args.includes('h264_nvenc'));
  assert.deepEqual(args.slice(args.indexOf('-preset'), args.indexOf('-preset') + 2), ['-preset', 'p3']);
  assert.deepEqual(args.slice(args.indexOf('-profile:v'), args.indexOf('-profile:v') + 2), ['-profile:v', 'high']);
  assert.deepEqual(args.slice(args.indexOf('-spatial-aq'), args.indexOf('-spatial-aq') + 2), ['-spatial-aq', '1']);
  assert.equal(args.includes('-pix_fmt'), false, 'gfxcapture hardware frames must not be forced through a software pixel format');
  assert.deepEqual(args.slice(args.indexOf('-bf'), args.indexOf('-bf') + 2), ['-bf', '0']);
  assert.deepEqual(args.slice(args.indexOf('-tune'), args.indexOf('-tune') + 2), ['-tune', 'ull']);
  assert.equal(args.at(-2), 'h264');
  assert.equal(args.at(-1), 'pipe:1');
});

test('decoder uses NVIDIA CUDA/NVDEC and decoded-frame showinfo', () => {
  const args = decoderArgs({ fps: 60, pid: 42 });
  assert.deepEqual(args.slice(args.indexOf('-hwaccel'), args.indexOf('-hwaccel') + 2), ['-hwaccel', 'cuda']);
  assert.deepEqual(args.slice(args.indexOf('-hwaccel_output_format'), args.indexOf('-hwaccel_output_format') + 2), ['-hwaccel_output_format', 'cuda']);
  assert.ok(args.some((arg) => arg.includes('showinfo')));
  assert.ok(args.includes('pipe:0'));
  assert.ok(args.includes('sdl2'));
  assert.ok(args.some((arg) => arg.includes('decoded preview')));
});

test('remote preview frame rate and JPEG quality are configurable', () => {
  const args = decoderArgs({ fps: 60, pid: 42, previewOutput: {}, previewFps: 60, previewJpegQuality: 7, previewMaxWidth: 768 });
  assert.ok(args.some((arg) => arg.includes('fps=60')));
  assert.ok(args.some((arg) => arg.includes('min(768,iw)')));
  assert.deepEqual(args.slice(args.indexOf('-q:v'), args.indexOf('-q:v') + 2), ['-q:v', '7']);
});

test('metrics bookkeeping queues remain bounded', () => {
  const metrics = new PipelineMetrics();
  for (let i = 0; i < 100; i += 1) metrics.captured(BigInt(i + 1) * 1_000_000n);
  assert.ok(metrics.captureQueue.length <= 2);
  for (let i = 0; i < 100; i += 1) metrics.encoded(BigInt(i + 101) * 1_000_000n);
  assert.ok(metrics.encodedQueue.length <= 2);
  assert.ok(metrics.correlationMisses > 0);
});
