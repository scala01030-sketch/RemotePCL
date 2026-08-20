'use strict';

const VideoCodec = Object.freeze({ H264: 'H264' });
const H264StreamFormat = Object.freeze({ ANNEX_B: 'ANNEX_B' });

function createEncodedFrame(fields) {
  if (!Buffer.isBuffer(fields.data)) throw new TypeError('EncodedFrame.data must be an encoded Buffer.');
  return Object.freeze({
    frameId: BigInt(fields.frameId),
    codec: fields.codec,
    pts: BigInt(fields.pts),
    dts: fields.dts === null || fields.dts === undefined ? null : BigInt(fields.dts),
    captureTimestamp: BigInt(fields.captureTimestamp),
    encodeCompleteTimestamp: BigInt(fields.encodeCompleteTimestamp),
    width: fields.width >>> 0,
    height: fields.height >>> 0,
    keyFrame: Boolean(fields.keyFrame),
    data: fields.data,
  });
}

function createCodecConfig(fields) {
  return Object.freeze({
    codec: VideoCodec.H264,
    streamFormat: H264StreamFormat.ANNEX_B,
    sps: Object.freeze(fields.sps.slice()),
    pps: Object.freeze(fields.pps.slice()),
    annexBData: Buffer.concat([...fields.sps, ...fields.pps]),
  });
}

module.exports = { VideoCodec, H264StreamFormat, createEncodedFrame, createCodecConfig };
