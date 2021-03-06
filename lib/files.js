exports.filesCreate = filesCreate;

const assert = require('assert');
const chalk = require('chalk');
const fs = require('fs');
const micromatch = require('micromatch');
const path = require('path');
const { asyncLoader, forwardSlashes, deleteFileWithRmdir, writeFileWithMkdir } = require('./util.js');

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

  // this.base = bucket_dir; // for Vinyl support
  // this.cwd = bucket_dir; // for Vinyl support
  // this.path = this.disk_path; // for Vinyl support
  // this.stat

  // state set by build system
  this.is_updated = false;
}
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

BuildFile.prototype.isUpdated = function () {
  return this.is_updated;
};

BuildFile.prototype.get = function (next) {
  this.files.get(this.bucket, this.relative, next);
};
BuildFile.prototype.getStat = function (next) {
  this.files.getStat(this.bucket, this.relative, 'BuildFile::getStat', next);
};

function Files(gb) {
  this.config = gb.config;
  this.buckets = Object.create(null);
  this.bucket_dirs = Object.create(null);
  this.statter = asyncLoader(statFile.bind(null, this));
  this.loader = asyncLoader(readFile.bind(null, this));
}

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

function statFile(files, file, next) {
  if (file.timestamp) {
    // already loaded, probably output from previous task
    return next();
  }
  let disk_path = diskPath(files, file);
  fs.stat(disk_path, function (err, stats) {
    if (err) {
      // Probably don't want this log, happens when any input is removed under
      // expected circumstances - tasks should error later anyway.
      // console.debug(`Could not stat file ${disk_path} for ${file.get_stat_for_who}:`, err);
      return next(err);
    }
    file.timestamp = stats.mtime.getTime();
    next(err);
  });
}

function readFile(files, file, next) {
  // TODO: if we get an error here, or in statFile, but the file gets modified, need to clear the .loader/.statter cache
  files.statter(file, function (err) {
    if (err) {
      return next(err);
    }
    if (file.contents) {
      // already loaded, probably output from previous task
      return next();
    }
    let disk_path = diskPath(files, file);
    console.debug(chalk.black.bold(`  Reading ${disk_path}...`));
    fs.readFile(disk_path, function (err, buf) {
      if (err) {
        console.error(`Could not read file ${disk_path}:`, err);
      }
      file.contents = buf;
      next(err);
    });
  });
}

function writeFile(files, file, cb) {
  let disk_path = diskPath(files, file);
  console.debug(`  Writing ${disk_path}...`);
  writeFileWithMkdir(disk_path, file.contents, cb);
}

Files.prototype.get = function (bucket_name, relative, cb) {
  assert(bucket_name);
  assert(relative);
  assert(relative.indexOf(':') === -1);
  assert.equal(typeof cb, 'function');

  let bucket = getBucket(this, bucket_name);
  let file = bucket[relative];
  if (!file) {
    file = bucket[relative] = new BuildFile(this, bucket_name, relative);
  }
  this.loader(file, cb);
};

Files.prototype.getStat = function (bucket_name, relative, for_who, cb) {
  assert(bucket_name);
  assert(relative);
  assert(relative.indexOf(':') === -1);
  assert.equal(typeof cb, 'function');

  let bucket = getBucket(this, bucket_name);
  let file = bucket[relative];
  if (!file) {
    file = bucket[relative] = new BuildFile(this, bucket_name, relative);
  }
  file.get_stat_for_who = for_who;
  this.statter(file, cb);
};

Files.prototype.put = function (opts, cb) {
  assert(opts.bucket);
  assert(opts.relative);
  assert(opts.who);
  let key = `${opts.bucket}:${opts.relative}`;
  if (!opts.contents) {
    return cb(new Error(`File "${key}" missing contents`));
  }
  let bucket = getBucket(this, opts.bucket);
  let file = bucket[opts.relative];
  if (file && file.who && file.who !== opts.who) {
    return cb(new Error(`File "${key}" was already output by ${file.who}, now again by ${opts.who}`));
  }
  if (!file) {
    file = bucket[opts.relative] = new BuildFile(this, opts.bucket, opts.relative);
  }
  file.contents = opts.contents;
  file.timestamp = Date.now(); // will be at least this, updated below with what gets written to disk
  file.who = opts.who;
  writeFile(this, file, (err) => {
    if (err) {
      return cb(err);
    }

    let disk_path = diskPath(this, file);
    fs.stat(disk_path, function (err, stat) {
      if (err) {
        console.error(`Could not stat file ${disk_path} we just wrote!`, err);
        return cb(err);
      }
      file.timestamp = stat.mtime.getTime();
      cb(null, file);
    });
  });
};

function pruneFile(files, file, cb) {
  let disk_path = forwardSlashes(path.join(files.bucket_dirs[file.bucket], file.relative));
  console.debug(`  Deleting ${disk_path}...`);
  deleteFileWithRmdir(disk_path, cb);
}

Files.prototype.prune = function (bucket_name, relative, cb) {
  let bucket = getBucket(this, bucket_name);
  let file = bucket[relative];
  if (file) {
    delete bucket[relative];
  }
  pruneFile(this, { bucket: bucket_name, relative: relative }, cb);
};

// returns map of file.relative to BuildFile
Files.prototype.glob = function (bucket_name, globs) {
  let bucket = getBucket(this, bucket_name);
  return micromatch.matchKeys(bucket, globs);
};

function filesCreate(gb) {
  return new Files(gb);
}
