const { doTestList, multiTest } = require('./test_runner.js');
// const gb = require('glov-build');
const gb = require('../../');
const { configure } = require('./test_tasks.js');

function testDelaysRegister() {
  configure({
    parallel: {
      tasks: 1,
      tasks_async: 1,
      jobs: 1,
      jobs_async: 1,
    },
  });

  function copySlow(job, done) {
    setTimeout(() => {
      job.out(job.getFile());
      done();
    }, 250);
  }
  gb.task({
    name: 'slow_copy',
    input: 'txt/*.txt',
    type: gb.SINGLE,
    func: copySlow,
  });
  gb.task({
    name: 'slow_copy_post',
    input: 'slow_copy:**',
    type: gb.SINGLE,
    func: copySlow,
    target: 'dev',
  });

  function copy(job, done) {
    job.out(job.getFile());
    done();
  }

  gb.task({
    name: 'copy',
    input: 'txt/*.txt',
    type: gb.SINGLE,
    target: 'dev',
    func: copy,
  });
}

doTestList([
  multiTest({ watch: true, register: testDelaysRegister }, [{
    name: 'change first-A while running first-A',
    tasks: ['slow_copy_post'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
      delayed: {
        125: {
          add: {
            'txt/file1.txt': 'file1b',
          },
        },
      },
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1b',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      jobs: 5,
    },
    results_abort: {
      jobs: 1,
    },
  }]),

  // Note: timing-sensitive tests below here, not super reliable?
  multiTest({ watch: true, register: testDelaysRegister }, [{
    name: 'change first-A while running first-B',
    tasks: ['slow_copy_post'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
      delayed: {
        400: {
          add: {
            'txt/file1.txt': 'file1b',
          },
        },
      },
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1b',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      jobs: 5,
    },
    results_abort: {
      jobs: 2,
    },
  }]),

  multiTest({ watch: true, register: testDelaysRegister }, [{
    name: 'change first while running second',
    tasks: ['slow_copy_post'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
      },
      delayed: {
        400: {
          add: {
            'txt/file1.txt': 'file1b',
          },
        },
      },
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1b',
      },
    },
    results: {
      jobs: 4,
    },
    results_abort: {
      jobs: 2,
    },
  }]),

  multiTest({ watch: true, register: testDelaysRegister }, [{
    name: 'change first while gathering inputs - pre',
    tasks: ['copy'],
    phase_delays: {
      inputs_pre: 250,
    },
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
      delayed: {
        100: {
          add: {
            'txt/file1.txt': 'file1b',
          },
        },
      },
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1b',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      jobs: 2,
      phase_inputs: 2,
      phase_deps: 1,
      phase_run: 1,
    },
    results_abort: {
      phase_inputs: 1,
      phase_deps: 0,
      phase_run: 0,
      jobs: 0,
    },
  }]),
  multiTest({ watch: true, register: testDelaysRegister }, [{
    name: 'change first while gathering inputs - post',
    tasks: ['copy'],
    phase_delays: {
      inputs_post: 250,
    },
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
      delayed: {
        100: {
          add: {
            'txt/file1.txt': 'file1b',
          },
        },
      },
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1b',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      jobs: 2,
      phase_inputs: 2,
      phase_deps: 1,
      phase_run: 1,
    },
    results_abort: {
      phase_inputs: 1,
      phase_deps: 0,
      phase_run: 0,
      jobs: 0,
    },
  }]),
  multiTest({ watch: true, register: testDelaysRegister }, [{
    name: 'change first while gathering deps',
    tasks: ['copy'],
    phase_delays: {
      deps: 250,
    },
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
      delayed: {
        100: {
          add: {
            'txt/file1.txt': 'file1b',
          },
        },
      },
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1b',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      jobs: 2,
      phase_inputs: 2,
      phase_deps: 2,
      phase_run: 1,
    },
    results_abort: {
      phase_inputs: 1,
      phase_deps: 1,
      phase_run: 0,
      jobs: 0,
    },
  }]),

  multiTest({ watch: true, register: testDelaysRegister }, [{
    name: 'delete first-B while running first-A',
    tasks: ['slow_copy_post'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
      delayed: {
        125: {
          del: [
            'txt/file2.txt'
          ],
        },
      },
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
      },
    },
    results: {
      jobs: 2,
    },
    results_abort: {
      jobs: 1,
    },
  }]),

  multiTest({ watch: true, register: testDelaysRegister }, [{
    name: 'delete first-A while running first-A',
    tasks: ['slow_copy_post'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
      delayed: {
        125: {
          del: [
            'txt/file1.txt'
          ],
        },
      },
    },
    outputs: {
      dev: {
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      jobs: 3,
    },
    results_abort: {
      jobs: 1,
    },
  }]),

]);
