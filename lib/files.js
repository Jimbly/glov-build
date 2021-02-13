const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Aim for roughly Vinyl-compatible?
function BuildFile(bucket, relative) {
  assert(bucket);
  assert(relative);
  assert(relative.indexOf(':') === -1);

  this.bucket = bucket;
  this.path = relative; // relative path from bucket
  this.key = `${bucket}:${relative}`;
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
  this.files = Object.create(null);
  this.buckets = Object.create(null);
}

Files.prototype.addBucket = function (key, dir) {
  assert(!this.buckets[key]);
  this.buckets[key] = dir;
};

function readFile(files, file) {
  let bucket_dir = files.buckets[file.bucket];
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
  let bucket_dir = files.buckets[file.bucket];
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

Files.prototype.get = function (bucket, relative, cb) {
  assert(bucket);
  assert(relative);
  assert(relative.indexOf(':') === -1);
  assert.equal(typeof cb, 'function');

  let filename = `${bucket}:${relative}`;
  let file = this.files[filename];
  if (!file) {
    file = this.files[filename] = new BuildFile(bucket, relative);
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
  let filekey = file.key;
  if (!file.contents) {
    return cb(new Error(`File "${filekey}" missing contents`));
  }
  if (this.files[filekey]) {
    return cb(new Error(`File "${filekey}" was already output`));
  }
  this.files[filekey] = file;
  writeFile(this, file, cb);
};

function filesCreate(gb) {
  return new Files(gb);
}
exports.filesCreate = filesCreate;
