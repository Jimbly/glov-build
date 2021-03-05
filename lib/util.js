exports.asyncLoader = asyncLoader;
exports.asyncSaver = asyncSaver;
exports.callbackify = callbackify;
exports.cmpTaskPhase = cmpTaskPhase;
exports.merge = merge;
exports.empty = empty;
exports.writeFileWithMkdir = writeFileWithMkdir;
exports.deleteFileWithRmdir = deleteFileWithRmdir;
exports.forwardSlashes = forwardSlashes;

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

function empty(obj) {
  for (let key in obj) {
    return false;
  }
  return true;
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

let mkdir_in_progress = {};
function writeFileWithMkdir(disk_path, contents, next) {
  fs.writeFile(disk_path, contents, function (err) {
    function finishWritefile() {
      // ignore error
      fs.writeFile(disk_path, contents, next);
    }
    if (err && (err.code === 'ENOENT' || err.code === 'EPERM')) {
      // Containing directory probably doesn't exist
      let dirname = path.dirname(disk_path);
      let cbs = mkdir_in_progress[dirname];
      if (cbs) {
        cbs.push(finishWritefile);
      } else {
        cbs = mkdir_in_progress[dirname] = [finishWritefile];
        console.debug(`Directory "${dirname}" does not exist, creating...`);
        fs.mkdir(dirname, { recursive: true }, function () {
          assert.equal(cbs, mkdir_in_progress[dirname]);
          delete mkdir_in_progress[dirname];
          for (let ii = 0; ii < cbs.length; ++ii) {
            cbs[ii]();
          }
        });
      }
    } else {
      next(err);
    }
  });
}

function rmdirtree(dir, next) {
  // just try to remove the directory - should maybe stat it first and check contents
  // if it's a symlink?
  fs.rmdir(dir, function (err) {
    if (err) {
      // probably not empty
      next();
    } else {
      let parent = path.dirname(dir);
      if (parent) {
        rmdirtree(parent, next);
      } else {
        next();
      }
    }
  });
}

function deleteFileWithRmdir(disk_path, next) {
  fs.unlink(disk_path, function (err1) {
    if (err1 && err1.code === 'ENOENT') {
      // already gone
      err1 = null;
    }
    rmdirtree(path.dirname(disk_path), function () {
      next(err1);
    });
  });
}


// function AsyncLoader(load_fn) {
//   this.load_cbs = [];
//   this.load_fn = load_fn;
//   this.err = null;
//   this.value = null;
//   this.load_fn(this.onLoad.bind(this));
// }
// AsyncLoader.prototype.onLoad = function (err, value) {
//   let cbs = this.load_cbs;
//   this.load_cbs = null;
//   this.err = err;
//   this.value = value;
//   for (let ii = 0; ii < cbs.length; ++ii) {
//     cbs[ii](err, value);
//   }
// };
// AsyncLoader.prototype.load = function (cb) {
//   if (!this.load_cbs) {
//     return cb(this.err, this.value);
//   }
//   this.load_cbs.push(cb);
// };
// function asyncLoader(load_fn) {
//   let loader = new AsyncLoader(load_fn);
//   return loader.load.bind(loader);
// }

function asyncLoader(load_fn) {
  const sym_load_cbs = Symbol('load_cbs');
  const sym_loaded = Symbol('loaded');
  const sym_err = Symbol('err');
  function load(obj) {
    load_fn(obj, function (err) {
      if (err) {
        obj[sym_err] = err;
      }
      let cbs = obj[sym_load_cbs];
      obj[sym_loaded] = true;
      obj[sym_load_cbs] = null;
      for (let ii = 0; ii < cbs.length; ++ii) {
        cbs[ii](obj[sym_err], obj);
      }
    });
  }
  return function (obj, cb) {
    if (obj[sym_loaded]) {
      return cb(obj[sym_err], obj);
    }
    if (obj[sym_load_cbs]) {
      return obj[sym_load_cbs].push(cb);
    }
    obj[sym_load_cbs] = [cb];
    load(obj);
  };
}

function asyncSaver(save_fn) {
  const sym_saving = Symbol('saving');
  function save(obj, cbs) {
    obj[sym_saving] = [];
    save_fn(obj, function (err) {
      for (let ii = 0; ii < cbs.length; ++ii) {
        cbs[ii](err);
      }
      if (obj[sym_saving].length) {
        save(obj, obj[sym_saving]);
      } else {
        delete obj[sym_saving];
      }
    });
  }
  return function (obj, cb) {
    if (obj[sym_saving]) {
      return obj[sym_saving].push(cb);
    }
    save(obj, [cb]);
  };
}

function forwardSlashes(str) {
  return str.replace(/\\/g, '/');
}
