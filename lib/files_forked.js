exports.filesForkedCreate = filesForkedCreate;

const { BuildFile, Files, filesGetBucket } = require('./files.js');


function FilesForked(gb) {
  this.gb = gb;
  this.config = gb.config;
  this.buckets = Object.create(null);
  this.bucket_dirs = Object.create(null);
  this.resetStats();
}
[
  'resetStats',
  'addBucket',
  'getBucketDir',
  'getDiskPath',
].forEach(function (key) {
  FilesForked.prototype[key] = Files.prototype[key];
});

FilesForked.prototype.addFiles = function (file_list) {
  return file_list.map((ser_file) => {
    let { bucket: bucket_name, relative } = ser_file;

    let bucket = filesGetBucket(this, bucket_name);
    let file = bucket[relative];
    if (!file) {
      file = bucket[relative] = new BuildFile(this, bucket_name, relative);
    }
    file.deserializeForFork(ser_file);
    return file;
  });
};

function filesForkedCreate(gb) {
  return new FilesForked(gb);
}
