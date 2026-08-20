export type VideoCodec = 'H264';
export type H264StreamFormat = 'ANNEX_B';

/** All timestamps and PTS values use one monotonic nanosecond clock domain. */
export interface EncodedFrame {
  readonly frameId: bigint;
  readonly codec: VideoCodec;
  readonly pts: bigint;
  readonly dts: bigint | null;
  readonly captureTimestamp: bigint;
  readonly encodeCompleteTimestamp: bigint;
  readonly width: number;
  readonly height: number;
  readonly keyFrame: boolean;
  /** One complete encoded H.264 Annex B access unit; read-only by contract. */
  readonly data: Uint8Array;
}

export interface CodecConfig {
  readonly codec: 'H264';
  readonly streamFormat: 'ANNEX_B';
  readonly sps: readonly Uint8Array[];
  readonly pps: readonly Uint8Array[];
  readonly annexBData: Uint8Array;
}

export interface EncodedFrameConsumer {
  configure?(config: CodecConfig): void;
  consume(frame: EncodedFrame): void;
  end?(): void;
}
