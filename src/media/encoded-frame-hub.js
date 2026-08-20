'use strict';

class EncodedFrameHub {
  constructor() { this.consumers = new Set(); }

  addConsumer(consumer) {
    if (!consumer || typeof consumer.consume !== 'function') throw new TypeError('Consumer must implement consume(frame).');
    this.consumers.add(consumer);
    return () => this.consumers.delete(consumer);
  }

  publishConfig(config) {
    for (const consumer of this.consumers) consumer.configure?.(config);
  }

  publish(frame) {
    for (const consumer of this.consumers) consumer.consume(frame);
  }

  end() {
    for (const consumer of this.consumers) consumer.end?.();
  }
}

module.exports = { EncodedFrameHub };
