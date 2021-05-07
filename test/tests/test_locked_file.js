const { doTestList, multiTest } = require('./test_runner.js');
const { asyncSeries } = require('glov-async');
const fsExt = require('fs-ext');
const fs = require('fs');

require('./test_tasks.js');

function delay(ms) {
  return (next) => {
    setTimeout(next, ms);
  };
}

doTestList([

  multiTest({ watch: true, serial: true }, [{
    name: 'locked file: initial',
    tasks: ['copy'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      jobs: 2,
    },
  },{
    name: 'locked file: lock and touch',
    tasks: ['copy'],
    ops: {
      func: [
        function (work_dir) {
          let test_fd;
          asyncSeries([
            function (next) {
              test_fd = fs.openSync(`${work_dir}/txt/file1.txt`, 'r+');
              next();
            },
            function (next) {
              console.log('locking');
              fsExt.flock(test_fd, 'ex', next);
            },
            function (next) {
              console.log('writing');
              fs.write(test_fd, 'file1b', next);
            },
            delay(2000),
            function (next) {
              console.log('unlocking');
              fsExt.flock(test_fd, 'un', next);
            },
            function (next) {
              console.log('closing');
              fs.close(test_fd, next);
            },
          ], function (err) {
            if (err) {
              throw err;
            }
          });
        },
      ],
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1b',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      errors: 0,
      jobs: 1,
    },
  }]),

  multiTest({ watch: true, serial: true }, [{
    name: 'locked file - slow write: initial',
    tasks: ['copy'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      jobs: 2,
    },
  },{
    name: 'locked file - slow write: lock and touch',
    tasks: ['copy'],
    ops: {
      func: [
        function (work_dir) {
          let test_fd;
          asyncSeries([
            function (next) {
              test_fd = fs.openSync(`${work_dir}/txt/file1.txt`, 'r+');
              next();
            },
            function (next) {
              console.log('locking');
              fsExt.flock(test_fd, 'ex', next);
            },
            function (next) {
              console.log('writing');
              fs.write(test_fd, 'file1b', next);
            },
            delay(2000),
            function (next) {
              console.log('writing suffix');
              fs.write(test_fd, 'suffix', next);
            },
            function (next) {
              console.log('unlocking');
              fsExt.flock(test_fd, 'un', next);
            },
            function (next) {
              console.log('closing');
              fs.close(test_fd, next);
            },
          ], function (err) {
            if (err) {
              throw err;
            }
          });
        },
      ],
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1bsuffix',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      errors: 0,
      jobs: 1,
    },
  }]),

  multiTest({ watch: true, serial: true }, [{
    name: 'locked file - quick: initial',
    tasks: ['copy'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      jobs: 2,
    },
  },{
    name: 'locked file - quick: lock and touch',
    tasks: ['copy'],
    ops: {
      func: [
        function (work_dir) {
          let test_fd;
          asyncSeries([
            function (next) {
              test_fd = fs.openSync(`${work_dir}/txt/file1.txt`, 'r+');
              next();
            },
            function (next) {
              console.log('locking');
              fsExt.flock(test_fd, 'ex', next);
            },
            function (next) {
              console.log('writing');
              fs.write(test_fd, 'file1b', next);
            },
            function (next) {
              console.log('unlocking');
              fsExt.flock(test_fd, 'un', next);
            },
            function (next) {
              console.log('closing');
              fs.close(test_fd, next);
            },
          ], function (err) {
            if (err) {
              throw err;
            }
          });
        },
      ],
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1b',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      errors: 0,
      jobs: 1,
    },
  }]),

  multiTest({ watch: true, serial: true }, [{
    name: 'locked file - final spurious: initial',
    tasks: ['copy'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      jobs: 2,
    },
  },{
    name: 'locked file - final spurious: lock and touch',
    tasks: ['copy'],
    ops: {
      func: [
        function (work_dir) {
          let test_fd;
          asyncSeries([
            function (next) {
              test_fd = fs.openSync(`${work_dir}/txt/file1.txt`, 'r+');
              next();
            },
            function (next) {
              console.log('locking');
              fsExt.flock(test_fd, 'ex', next);
            },
            function (next) {
              console.log('writing');
              fs.write(test_fd, 'file1b', next);
            },
            delay(2000),
            function (next) {
              console.log('unlocking');
              fsExt.flock(test_fd, 'un', next);
            },
            function (next) {
              console.log('closing');
              fs.close(test_fd, next);
            },
            function (next) {
              let stat = fs.statSync(`${work_dir}/txt/file2.txt`);
              fs.utimes(`${work_dir}/txt/file2.txt`, stat.atime, stat.mtime, next);
            },
          ], function (err) {
            if (err) {
              throw err;
            }
          });
        },
      ],
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1b',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      errors: 0,
      jobs: 1,
    },
  }]),

]);
