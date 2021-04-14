// const gb = require('glov-build');
const gb = require('../../');
const fs = require('fs');
const path = require('path');
const { doTestList, multiTest } = require('./test_runner.js');
const {
  targets, STATE_DIR, WORK_DIR,
} = require('./test_tasks.js');

function copy(job, done) {
  job.out(job.getFile());
  done();
}

function register() {
  gb.configure({
    source: WORK_DIR,
    statedir: STATE_DIR,
    targets,
    log_level: gb.LOG_SILLY,
  });

  gb.task({
    name: 'copy',
    input: '**',
    type: gb.SINGLE,
    target: 'dev',
    func: copy,
  });
}

let opts = { serial: true, watch: true, register };

doTestList([
  multiTest(opts, [{
    name: 'copy to dev',
    tasks: ['copy'],
    ops: {
      add: {
        'file1.txt': 'file1',
        'file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'file1.txt': 'file1',
        'file2.txt': 'file2',
      },
    },
    results: {
      fs_read: 2,
      fs_write: 2,
      fs_stat: 2,
      fs_delete: 0,
      jobs: 2,
    },
  }, {
    name: 'spurious',
    tasks: ['copy'],
    ops: {
      spurious: [
        'file1.txt',
      ]
    },
    outputs: {
      dev: {
        'file1.txt': 'file1',
        'file2.txt': 'file2',
      },
    },
    results: {
      fs_read: 0,
      fs_write: 0,
      fs_delete: 0,
      jobs: 0,
    },
    results_watch: {
      fs_stat: 0,
    },
    results_serial: {
      fs_stat: 4,
    },
  }, {
    name: 'spurious with output touched',
    tasks: ['copy'],
    ops: {
      spurious: [
        'file2.txt',
      ],
      func: [
        function () {
          let full_path = path.join(targets.dev, 'file1.txt');
          let stat = fs.statSync(full_path);
          fs.utimesSync(full_path, new Date(stat.atime.getTime() - 10000), new Date(stat.mtime.getTime() - 10000));
        },
      ],
    },
    outputs: {
      dev: {
        'file1.txt': 'file1',
        'file2.txt': 'file2',
      },
    },
    results: {
      fs_read: 0,
      fs_delete: 0,
    },
    results_watch: {
      fs_write: 0,
      fs_stat: 0,
      jobs: 0, // do not check timestamps of outputs at run-time!
    },
    results_serial: {
      fs_stat: 4,
      fs_write: 1, // overwrites the (admittedly identical) output, just to update timestamps/crc
      fs_read: 1,
      jobs: 1, // re-runs job, but should not touch output file
    },
  }, {
    name: 'file1 untouched',
    tasks: ['copy'],
    ops: {
      add: {
        'file2.txt': 'file2b',
      },
    },
    outputs: {
      dev: {
        'file1.txt': 'file1',
        'file2.txt': 'file2b',
      },
    },
    results: {
      fs_read: 1,
      fs_write: 1,
      fs_delete: 0,
      jobs: 1, // should NOT re-run file1 job because "output changed", should have been resolved in previous run
    },
    results_watch: {
      fs_stat: 0,
    },
    results_serial: {
      fs_stat: 4,
    },
  }]),
]);
