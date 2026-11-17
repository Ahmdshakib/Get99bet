'use strict';

/** Minimal promise-based mutex: run(fn) executes fn exclusively, in call order. */
class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  run(fn) {
    const result = this._tail.then(() => fn());
    this._tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

module.exports = { Mutex };
