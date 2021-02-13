exports.callbackify = callbackify;
exports.merge = merge;
exports.cmpTaskPhase = cmpTaskPhase;

const assert = require('assert');

function merge(dest, src) {
  for (let key in src) {
    let value = src[key];
    if (typeof value === 'object') {
      value = merge(dest[key] || {}, value);
    }
    dest[key] = value;
  }
  return dest;
}


function callbackify(f) {
  return function () {
    let cb = arguments[arguments.length - 1]; // eslint-disable-line prefer-rest-params
    assert.equal(typeof cb, 'function');
    let args = Array.prototype.slice.call(arguments, 0, -1); // eslint-disable-line prefer-rest-params
    let p = f.apply(this, args); // eslint-disable-line no-invalid-this
    p.then((result) => {
      if (cb) {
        // escape promise so it doesn't catch and re-throw the error!
        process.nextTick(cb.bind(this, null, result)); // eslint-disable-line no-invalid-this
        cb = null;
      }
    }).catch((err) => {
      if (cb) {
        process.nextTick(cb.bind(this, err)); // eslint-disable-line no-invalid-this
        cb = null;
      }
    });
  };
}

function cmpTaskPhase(a, b) {
  return (b.phase - a.phase) || (a.uid - b.uid);
}
