exports.filesCreate = filesCreate;
const DELETED_TIMESTAMP = exports.DELETED_TIMESTAMP = -1;

const assert = require('assert');
const fs = require('fs');
const micromatch = require('micromatch');
const path = require('path');
const { asyncLoader, forwardSlashes, deleteFileWithRmdir, writeFileWithMkdir } = require('./util.js');

// This is not the exclusive error if the file does not exist, only if it was pruned by us
const ERR_DOES_NOT_EXIST = 'ERR_DOES_NOT_EXIST';
const ERR_CASE_MISMATCH = 'ERR_CASE_MISMATCH';

// Aim for roughly Vinyl-compatible?
function BuildFile(files, bucket_name, relative) {
  assert(bucket_name);
  assert(relative);
  assert(relative.indexOf(':') === -1);

  this.files = files;
  this.bucket = bucket_name;
  this.relative = relative; // relative path from bucket
  let bucket_dir = files.bucket_dirs[bucket_name];
  assert(bucket_dir);
  this.disk_path = forwardSlashes(path.join(bucket_dir, relative));
  this.key = `${bucket_name}:${relative}`;
  this.contents = null;
  this.timestamp = 0; // TODO populate on read (from glob/filesystem search)
  this.err = null;

  // this.base = bucket_dir; // for Vinyl support
  // this.cwd = bucket_dir; // for Vinyl support
  // this.path = this.disk_path; // for Vinyl support
  // this.stat
}
exports.isBuildFile = function isBuildFile(file) {
  return file instanceof BuildFile;
};
BuildFile.prototype.getDiskPath = function () {
  return this.disk_path;
};
BuildFile.prototype.getBucketDir = function () {
  return this.files.getBucketDir(this.bucket);
};
BuildFile.prototype.toVinyl = function () {
  let bucket_dir = this.files.bucket_dirs[this.bucket];
  return {
    cwd: bucket_dir,
    base: bucket_dir,
    path: this.disk_path,
    contents: this.contents,
  };
};
// BuildFile.prototype.isBuffer = function () {  // for Vinyl support
//   return true;
// };
// BuildFile.prototype.isNull = function () {  // for Vinyl support
//   return false;
// };
// BuildFile.prototype.isStream = function () {  // for Vinyl support
//   return false;
// };
// BuildFile.prototype.clone = function (opts) {  // for Vinyl support
//   let ret = new BuildFile(this.files, this.bucket, this.relative);
//   if (Buffer.isBuffer(this.contents)) {
//     if (opts.contents === false) {
//       ret.contents = this.contents;
//     } else {
//       ret.contents = Buffer.from(this.contents);
//     }
//   } else {
//     ret.contents = this.contents;
//   }
//   return ret;
// };

BuildFile.prototype.get = function (next) {
  this.files.get(this.bucket, this.relative, next);
};
BuildFile.prototype.getStat = function (next) {
  this.files.getStat(this.bucket, this.relative, 'BuildFile::getStat', next);
};

function Files(gb) {
  this.gb = gb;
  this.config = gb.config;
  this.buckets = Object.create(null);
  this.bucket_dirs = Object.create(null);
  this.statter = asyncLoader(statFile.bind(null, this));
  this.loader = asyncLoader(readFile.bind(null, this));
  this.resetStats();
}
Files.prototype.resetStats = function () {
  this.stats = {
    read: 0,
    write: 0,
    stat: 0,
    delete: 0,
  };
};

Files.prototype.addBucket = function (bucket_name, dir) {
  assert(!this.bucket_dirs[bucket_name]);
  this.bucket_dirs[bucket_name] = forwardSlashes(dir);
};

Files.prototype.getBucketDir = function (bucket_name) {
  return this.bucket_dirs[bucket_name];
};

function getBucket(files, bucket_name) {
  let bucket = files.buckets[bucket_name];
  if (!bucket) {
    bucket = files.buckets[bucket_name] = Object.create(null);
  }
  return bucket;
}

function diskPath(files, file) {
  assert(file.disk_path);
  return file.disk_path;
}

Files.prototype.getDiskPath = function (bucket_name, relative) {
  let bucket_dir = this.bucket_dirs[bucket_name];
  assert(bucket_dir);
  return forwardSlashes(path.join(bucket_dir, relative));
};

function statFile(files, file, next) {
  if (file.timestamp) {
    // already loaded, probably output from previous task
    return next();
  }
  let disk_path = diskPath(files, file);
  files.stats.stat++;
  files.gb.silly(`  Statting ${disk_path}...`);
  fs.stat(disk_path, function (err, stats) {
    if (err) {
      // Probably don't want this log, happens when any input is removed under
      // expected circumstances - tasks should error later anyway.
      // files.gb.debug(`Could not stat file ${disk_path} for ${file.get_stat_for_who}:`, err);
      file.err = err;
      file.timestamp = DELETED_TIMESTAMP;
      assert(!file.contents);
      return next(err);
    }
    fs.realpath.native(disk_path, (err, real_path) => {
      if (err) {
        // unexpected - race condition?
        files.gb.warn(`Could not get realpath of ${disk_path} for ${file.get_stat_for_who}:`, err);
        file.err = err;
        file.timestamp = DELETED_TIMESTAMP;
      } else {
        real_path = forwardSlashes(real_path);
        if (!real_path.endsWith(disk_path)) {
          file.err = ERR_CASE_MISMATCH;
          file.timestamp = DELETED_TIMESTAMP;
        } else {
          file.err = null;
          file.timestamp = stats.mtime.getTime();
        }
      }
      next(file.err);
    });
  });
}

function readFileWithRetries(files, disk_path, next) {
  let retries = 0;
  function doAttempt() {
    fs.readFile(disk_path, function (err, buf) {
      if (!err) {
        return next(err, buf);
      }
      if (err.code === 'ENOENT') {
        // file no longer exists, immediately fail
        files.gb.debug(`File disappeared while reading "${disk_path}"`);
        return next(ERR_DOES_NOT_EXIST, buf);
      }
      ++retries;
      let delay;
      let max_retries;
      if (err.code === 'EBUSY') {
        // someone else is still actively writing this file, try again repeatedly until
        // we get access
        delay = 100;
        max_retries = 150; // 100ms each, 15s total
        files.gb[retries % 5 ? 'debug' : 'info'](`File "${disk_path}" busy, retrying (${retries})...`);
      } else {
        delay = retries * retries * 100;
        max_retries = 5; // last delay of 2500ms
        files.gb.debug(`Error reading file "${disk_path}": ${err.code || err}, retrying (${retries})...`);
      }
      if (retries >= max_retries) {
        // out of retries
        files.gb.info(`Retries (${retries}) exhausted while reading "${disk_path}"`);
        return next(err, buf);
      }
      setTimeout(doAttempt, delay);
    });
  }
  doAttempt();
}

function readFile(files, file, next) {
  // TODO: if we get an error here, or in statFile, but the file gets modified, need to clear the .loader/.statter cache
  files.statter(file, function (err) {
    if (err) {
      file.err = err;
      return next(err);
    }
    if (file.contents) {
      // already loaded, probably output from previous task
      return next();
    }
    let disk_path = diskPath(files, file);
    files.gb.silly(`  Reading ${disk_path}...`);
    files.stats.read++;
    readFileWithRetries(files, disk_path, function (err, buf) {
      if (err) {
        file.err = err;
        file.contents = null;
        files.gb.error(`Could not read file ${disk_path}:`, err);
      } else {
        file.err = null;
        file.contents = buf;
      }
      next(err);
    });
  });
}

function writeFile(files, file, cb) {
  let disk_path = diskPath(files, file);
  files.gb.debug(`  Writing ${disk_path}...`);
  files.stats.write++;
  writeFileWithMkdir(files.gb, disk_path, file.contents, cb);
}

Files.prototype.getPre = function (bucket_name, relative) {
  assert(bucket_name);
  assert(relative);
  assert(relative.indexOf(':') === -1);

  let bucket = getBucket(this, bucket_name);
  let file = bucket[relative];
  if (!file) {
    file = bucket[relative] = new BuildFile(this, bucket_name, relative);
  }
  return file;
};

Files.prototype.get = function (bucket_name, relative, cb) {
  assert.equal(typeof cb, 'function');

  let file = this.getPre(bucket_name, relative);
  this.loader(file, cb);
};

Files.prototype.getStat = function (bucket_name, relative, for_who, cb) {
  assert.equal(typeof cb, 'function');

  let file = this.getPre(bucket_name, relative);
  file.get_stat_for_who = for_who;
  this.statter(file, cb);
};

Files.prototype.put = function (opts, cb) {
  assert(opts.bucket);
  assert(opts.relative);
  assert(opts.who);
  let key = `${opts.bucket}:${opts.relative}`;
  let { contents } = opts;
  if (!contents) {
    return cb(new Error(`File "${key}" missing contents`));
  }
  if (typeof contents === 'string') {
    contents = Buffer.from(contents);
  } else if (Buffer.isBuffer(contents)) {
    // pass through
  } else {
    return cb(new Error(`File "${key}" contents must be a Buffer or String`));
  }
  let bucket = getBucket(this, opts.bucket);
  let file = bucket[opts.relative];
  if (file && file.who && file.who !== opts.who) {
    return cb(new Error(`File "${key}" was already output by ${file.who}, now again by ${opts.who}`));
  }
  if (!file) {
    file = bucket[opts.relative] = new BuildFile(this, opts.bucket, opts.relative);
  }
  file.err = null;
  file.contents = contents;
  file.who = opts.who;
  this.loader.reset(file, true, file.err);
  if (opts.skip_write) { // Just updating our cache
    assert(opts.timestamp);
    file.timestamp = opts.timestamp;
    this.statter.reset(file, true, file.err);
    cb(null, file);
  } else {
    file.timestamp = Date.now(); // will be at least this, updated below with what gets written to disk
    writeFile(this, file, (err) => {
      if (err) {
        return cb(err);
      }

      let disk_path = diskPath(this, file);
      // this.stats.stat++; // don't count this, for the purpose of tests, this doesn't make sense
      fs.stat(disk_path, (err, stat) => {
        if (err) {
          this.gb.error(`Could not stat file ${disk_path} we just wrote!`, err);
          return cb(err);
        }
        file.timestamp = stat.mtime.getTime();
        this.statter.reset(file, true, file.err);
        cb(null, file);
      });
    });
  }
};

function pruneFile(files, file, cb) {
  let disk_path = forwardSlashes(path.join(files.bucket_dirs[file.bucket], file.relative));
  files.stats.delete++;
  files.gb.debug(`  Deleting ${disk_path}...`);
  deleteFileWithRmdir(disk_path, cb);
}

Files.prototype.fsEventDeleteUseful = function (bucket_name, relative) {
  let bucket = getBucket(this, bucket_name);
  let file = bucket[relative];
  if (file && file.timestamp === DELETED_TIMESTAMP) {
    return false;
  }
  return true;
};
Files.prototype.registerDelete = function (bucket_name, relative) {
  let bucket = getBucket(this, bucket_name);
  let file = bucket[relative];
  if (file) {
    if (file.timestamp === DELETED_TIMESTAMP) {
      return;
    }
    file.err = ERR_DOES_NOT_EXIST;
    file.timestamp = DELETED_TIMESTAMP;
    file.contents = null;
    file.who = null;
    this.statter.reset(file, true, file.err);
    this.loader.reset(file, true, file.err);
  }
};

Files.prototype.prune = function (bucket_name, relative, cb) {
  this.registerDelete(bucket_name, relative);
  pruneFile(this, { bucket: bucket_name, relative: relative }, cb);
};

// Returns true if it would do anything
Files.prototype.fsEventUseful = function (event, bucket_name, relative, opt_stat) {
  if (event === 'unlink') {
    return this.fsEventDeleteUseful(bucket_name, relative);
  } else if (event === 'change' || event === 'add') {
    let bucket = getBucket(this, bucket_name);
    let file = bucket[relative];
    if (file) {
      if (opt_stat && file.timestamp === opt_stat.mtime.getTime()) {
        return false;
      }
    }
    return true;
  } else {
    assert(false, `Unhandled FS event: ${event}`);
  }
  return true;
};

Files.prototype.fsEvent = function (event, bucket_name, relative, opt_stat) {
  // TODO: what about getStat()s already in-flight?  Will assert for now
  //    Shouldn't be an issue after fsEvent calls are delayed until the build
  //    stabilizes?
  if (event === 'unlink') {
    this.registerDelete(bucket_name, relative);
  } else if (event === 'change' || event === 'add') {
    // Just reset the cache, we'll stat the disk again if needed
    let bucket = getBucket(this, bucket_name);
    let file = bucket[relative];
    if (file) {
      if (opt_stat && file.timestamp === opt_stat.mtime.getTime()) {
        // Should have been filtered with fsEventUseful, but possibly get hit if
        //   we get a useful change followed by a spurious change, all queued at
        //   once.
        return;
      }
      file.err = null;
      file.contents = null;
      if (opt_stat) {
        file.timestamp = opt_stat.mtime.getTime();
        this.statter.reset(file, true);
      } else {
        file.timestamp = 0;
        this.statter.reset(file, false);
      }
      this.loader.reset(file, false);
    }
  } else {
    assert(false, `Unhandled FS event: ${event}`);
  }
};

// returns map of file.relative to BuildFile
Files.prototype.glob = function (bucket_name, globs) {
  let bucket = getBucket(this, bucket_name);
  let ret = micromatch.matchKeys(bucket, globs);
  for (let key in ret) {
    if (ret[key].timestamp === DELETED_TIMESTAMP) {
      // deleted file
      delete ret[key];
    }
  }
  return ret;
};

function filesCreate(gb) {
  return new Files(gb);
}
