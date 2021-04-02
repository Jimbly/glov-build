exports.filesCreate = filesCreate;

const assert = require('assert');
const fs = require('fs');
const micromatch = require('micromatch');
const path = require('path');
const { asyncLoader, forwardSlashes, deleteFileWithRmdir, writeFileWithMkdir } = require('./util.js');

// This is not the exclusive error if the file does not exist, only if it was pruned by us
const ERR_DOES_NOT_EXIST = 'ERR_DOES_NOT_EXIST';
const DELETED_TIMESTAMP = -1;

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
  this.bucket_dirs[bucket_name] = dir;
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

// Files.prototype.getDiskPath = function () {
//   return diskPath(this.files, this);
// };

function statFile(files, file, next) {
  if (file.timestamp) {
    // already loaded, probably output from previous task
    return next();
  }
  let disk_path = diskPath(files, file);
  files.stats.stat++;
  // files.gb.debug(`  Statting ${disk_path}...`);
  fs.stat(disk_path, function (err, stats) {
    if (err) {
      // Probably don't want this log, happens when any input is removed under
      // expected circumstances - tasks should error later anyway.
      // files.gb.debug(`Could not stat file ${disk_path} for ${file.get_stat_for_who}:`, err);
      file.err = err;
      file.timestamp = DELETED_TIMESTAMP;
      assert(!file.contents);
    } else {
      file.err = null;
      file.timestamp = stats.mtime.getTime();
    }
    next(err);
  });
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
    fs.readFile(disk_path, function (err, buf) {
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
  files.gb.info(`  Writing ${disk_path}...`);
  files.stats.write++;
  writeFileWithMkdir(disk_path, file.contents, cb);
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
  file.contents = contents;
  file.timestamp = Date.now(); // will be at least this, updated below with what gets written to disk
  file.who = opts.who;
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
      cb(null, file);
    });
  });
};

function pruneFile(files, file, cb) {
  let disk_path = forwardSlashes(path.join(files.bucket_dirs[file.bucket], file.relative));
  files.stats.delete++;
  deleteFileWithRmdir(disk_path, cb);
}

Files.prototype.registerDelete = function (bucket_name, relative) {
  let bucket = getBucket(this, bucket_name);
  let file = bucket[relative];
  if (file) {
    if (file.timestamp === DELETED_TIMESTAMP) {
      return false;
    }
    file.err = ERR_DOES_NOT_EXIST;
    file.timestamp = DELETED_TIMESTAMP;
    file.contents = null;
    this.statter.reset(file, true, file.err);
    this.loader.reset(file, true, file.err);
  }
  return true;
};

Files.prototype.prune = function (bucket_name, relative, cb) {
  this.registerDelete(bucket_name, relative);
  pruneFile(this, { bucket: bucket_name, relative: relative }, cb);
};

// Returns true if it did anything
Files.prototype.fsEvent = function (event, bucket_name, relative, opt_stat) {
  // TODO: what about getStat()s already in-flight?  Will assert for now
  if (event === 'unlink') {
    return this.registerDelete(bucket_name, relative);
  } else if (event === 'change' || event === 'add') {
    // Just reset the cache, we'll stat the disk again if needed
    let bucket = getBucket(this, bucket_name);
    let file = bucket[relative];
    if (file) {
      if (opt_stat && file.timestamp === opt_stat.mtime.getTime()) {
        return false;
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
  return true;
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
