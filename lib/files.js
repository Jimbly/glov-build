const path = require('path');
const fs = require('fs');

function BuildFile(filename) {
  this.name = filename;
  this.load_cbs = [];
  this.err = null;
}

function Files(config) {
  this.config = config;
  this.files = {};
}

function readFile(files, file) {
  let disk_path = path.join(files.config.root, file.name);
  fs.readFile(disk_path, function (err, buf) {
    file.err = err;
    file.buffer = buf;
    let cbs = file.load_cbs;
    file.load_cbs = null;
    for (let ii = 0; ii < cbs.length; ++ii) {
      cbs[ii](file.err, file);
    }
  });
}

Files.prototype.get = function (filename, cb) {
  let file = this.files[filename];
  if (!file) {
    file = this.files[filename] = new BuildFile(filename);
    readFile(this, file);
  }
  if (file.load_cbs) {
    file.load_cbs.push(cb);
  } else {
    cb(file.err, file);
  }
};

function filesCreate(config) {
  return new Files(config);
}
exports.filesCreate = filesCreate;
