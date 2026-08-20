'use strict';

const { VideoCodec, createEncodedFrame, createCodecConfig } = require('./encoded-frame');

function scanNals(data) {
  const nals = [];
  for (let i = 0; i + 3 < data.length; i += 1) {
    let prefixLength = 0;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) prefixLength = 3;
    else if (i + 4 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) prefixLength = 4;
    if (prefixLength) {
      const nalOffset = i + prefixLength;
      nals.push({ offset: i, prefixLength, type: data[nalOffset] & 0x1f });
      i = nalOffset;
    }
  }
  return nals.map((nal, index) => ({
    ...nal,
    end: index + 1 < nals.length ? nals[index + 1].offset : data.length,
  }));
}

class EncodedFrameParser {
  constructor({ width, height, timestampSource, onFrame, onConfig }) {
    this.width = width;
    this.height = height;
    this.timestampSource = timestampSource;
    this.onFrame = onFrame;
    this.onConfig = onConfig;
    this.buffer = Buffer.alloc(0);
    this.frameId = 0n;
    this.clockOrigin = process.hrtime.bigint();
    this.lastConfigSignature = '';
  }

  push(chunk, encodeCompleteTimestamp = process.hrtime.bigint()) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.emitCompleteAccessUnits(encodeCompleteTimestamp);
  }

  emitCompleteAccessUnits(nowNs) {
    while (true) {
      const auds = scanNals(this.buffer).filter((nal) => nal.type === 9);
      if (auds.length < 2) return;
      const firstOffset = auds[0].offset;
      const secondOffset = auds[1].offset;
      if (firstOffset > 0) {
        // Preserve leading SPS/PPS by attaching it to the first access unit.
        this.emitAccessUnit(this.buffer.subarray(0, secondOffset), nowNs);
      } else {
        this.emitAccessUnit(this.buffer.subarray(firstOffset, secondOffset), nowNs);
      }
      this.buffer = this.buffer.subarray(secondOffset);
    }
  }

  emitAccessUnit(data, encodeCompleteTimestamp) {
    const nals = scanNals(data);
    const sps = nals.filter((nal) => nal.type === 7).map((nal) => Buffer.from(data.subarray(nal.offset, nal.end)));
    const pps = nals.filter((nal) => nal.type === 8).map((nal) => Buffer.from(data.subarray(nal.offset, nal.end)));
    if (sps.length && pps.length) {
      const signature = Buffer.concat([...sps, ...pps]).toString('base64');
      if (signature !== this.lastConfigSignature) {
        this.lastConfigSignature = signature;
        this.onConfig(createCodecConfig({ sps, pps }));
      }
    }
    const captureTimestamp = this.timestampSource() || encodeCompleteTimestamp;
    this.frameId += 1n;
    this.onFrame(createEncodedFrame({
      frameId: this.frameId,
      codec: VideoCodec.H264,
      pts: captureTimestamp - this.clockOrigin,
      dts: null,
      captureTimestamp,
      encodeCompleteTimestamp,
      width: this.width,
      height: this.height,
      keyFrame: nals.some((nal) => nal.type === 5),
      data: Buffer.from(data),
    }));
  }

  flush(nowNs = process.hrtime.bigint()) {
    if (scanNals(this.buffer).some((nal) => nal.type === 9)) this.emitAccessUnit(this.buffer, nowNs);
    this.buffer = Buffer.alloc(0);
  }
}

module.exports = { EncodedFrameParser, scanNals };
