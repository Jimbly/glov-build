exports.filesCreate = filesCreate;

const assert = require('assert');
const micromatch = require('micromatch');
const path = require('path');
const fs = require('fs');

// Aim for roughly Vinyl-compatible?
function BuildFile(bucket_name, relative) {
  assert(bucket_name);
  assert(relative);
  assert(relative.indexOf(':') === -1);

  this.bucket = bucket_name;
  this.path = relative; // relative path from bucket
  // this.key = `${bucket_name}:${relative}`;
  this.contents = null;
  // this.base
  // this.cwd = files.config.source
  // this.stat

  this.load_cbs = [];
  this.err = null;

  // state set by build system
  this.is_updated = false;
}
BuildFile.prototype.isBuffer = function () {
  return true;
};

BuildFile.prototype.isUpdated = function () {
  return this.is_updated;
};

function Files(gb) {
  this.config = gb.config;
  this.buckets = Object.create(null);
  this.bucket_dirs = Object.create(null);
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

function readFile(files, file) {
  let bucket_dir = files.bucket_dirs[file.bucket];
  assert(bucket_dir);
  let disk_path = path.join(bucket_dir, file.path);
  console.log(`Reading ${disk_path}...`);
  fs.readFile(disk_path, function (err, buf) {
    file.err = err;
    file.contents = buf;
    let cbs = file.load_cbs;
    file.load_cbs = null;
    for (let ii = 0; ii < cbs.length; ++ii) {
      cbs[ii](file.err, file);
    }
  });
}

function writeFile(files, file, cb) {
  let bucket_dir = files.bucket_dirs[file.bucket];
  assert(bucket_dir);
  let disk_path = path.join(bucket_dir, file.path);
  console.log(`Writing ${disk_path}...`);
  fs.writeFile(disk_path, file.contents, function (err) {
    if (err && err.code === 'ENOENT') {
      // Containing directory probably doesn't exist
      let dirname = path.dirname(disk_path);
      console.log(`Directory "${dirname}" does not exist, creating...`);
      fs.mkdir(dirname, { recursive: true }, function () {
        // ignore error
        fs.writeFile(disk_path, file.contents, cb);
      });
    } else {
      cb(err);
    }
  });
}

Files.prototype.get = function (bucket_name, relative, cb) {
  assert(bucket_name);
  assert(relative);
  assert(relative.indexOf(':') === -1);
  assert.equal(typeof cb, 'function');

  let bucket = getBucket(this, bucket_name);
  let file = bucket[relative];
  if (!file) {
    file = bucket[relative] = new BuildFile(bucket_name, relative);
    readFile(this, file);
  }
  if (file.load_cbs) {
    file.load_cbs.push(cb);
  } else {
    cb(file.err, file);
  }
};

Files.prototype.newFile = function (opts) {
  let file = new BuildFile(opts.bucket, opts.path);
  file.contents = opts.contents;
  return file;
};

Files.prototype.put = function (file, cb) {
  assert(file.bucket);
  assert(file.path);
  if (!file.contents) {
    return cb(new Error(`File "${file.bucket}:${file.path}" missing contents`));
  }
  let bucket = getBucket(this, file.bucket);
  if (bucket[file.path]) {
    return cb(new Error(`File "${file.bucket}:${file.path}" was already output`));
  }
  assert(file.load_cbs);
  assert(!file.load_cbs.length);
  file.load_cbs = null;
  bucket[file.path] = file;
  writeFile(this, file, cb);
};

// returns map of file.path to BuildFile
Files.prototype.glob = function (bucket_name, globs) {
  let bucket = getBucket(this, bucket_name);
  return micromatch.matchKeys(bucket, globs);
};

function filesCreate(gb) {
  return new Files(gb);
}
