'use strict';

class LocalDecoderConsumer {
  constructor(input, { maxQueueDepth = 2, onDrop = () => {}, onBackpressure = () => {} } = {}) {
    this.input = input;
    this.maxQueueDepth = maxQueueDepth;
    this.onDrop = onDrop;
    this.onBackpressure = onBackpressure;
    this.queue = [];
    this.codecConfig = null;
    this.awaitKeyFrame = false;
    this.needsConfig = true;
    this.blocked = false;
    this.ended = false;
  }

  configure(config) { this.codecConfig = config; }

  consume(frame) {
    if (this.ended) return;
    if (this.awaitKeyFrame && !frame.keyFrame) { this.onDrop(frame); return; }
    if (this.queue.length >= this.maxQueueDepth) {
      for (const stale of this.queue.splice(0)) this.onDrop(stale);
      this.awaitKeyFrame = true;
      this.needsConfig = true;
      if (!frame.keyFrame) { this.onDrop(frame); return; }
    }
    if (frame.keyFrame) this.awaitKeyFrame = false;
    this.queue.push(frame);
    this.pump();
  }

  pump() {
    if (this.blocked || this.ended) return;
    while (this.queue.length) {
      const frame = this.queue.shift();
      if (frame.keyFrame && this.needsConfig && this.codecConfig) {
        if (!this.input.write(this.codecConfig.annexBData)) {
          this.blocked = true;
          this.onBackpressure();
          this.input.once('drain', () => { this.blocked = false; this.pump(); });
        }
        this.needsConfig = false;
      }
      if (!this.input.write(frame.data)) {
        this.blocked = true;
        this.onBackpressure();
        this.input.once('drain', () => { this.blocked = false; this.pump(); });
        return;
      }
    }
  }

  end() { this.ended = true; this.input.end(); }
  get queueDepth() { return this.queue.length; }
}

module.exports = { LocalDecoderConsumer };
