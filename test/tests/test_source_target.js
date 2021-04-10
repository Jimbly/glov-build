// const gb = require('glov-build');
const gb = require('../../');
const { doTestList, multiTest } = require('./test_runner.js');

const { configure } = require('./test_tasks.js');

function copy(job, done) {
  job.out(job.getFile());
  done();
}

function rename(new_ext) {
  return function (job, done) {
    let file = job.getFile();
    job.out({
      relative: file.relative + new_ext,
      contents: file.contents,
    });
    done();
  };
}

function register() {
  configure();

  gb.task({
    name: 's1',
    input: '*.s1',
    type: gb.SINGLE,
    target: 'dev',
    func: copy,
  });

  gb.task({
    name: 's2',
    input: '*.s2',
    type: gb.SINGLE,
    target: 'dev',
    func: copy,
  });

  gb.task({
    name: 's1b',
    input: 's1:**',
    type: gb.SINGLE,
    target: 'dev',
    func: rename('.s1b'),
  });
}

doTestList([
  multiTest({ watch: true, serial: true, register }, [{
    name: 'initial',
    tasks: ['s2', 's1b'],
    ops: {
      add: {
        'file1.s1': 'file1',
        'file2.s1': 'file2',
        'file3.s2': 'file3',
      }
    },
    outputs: {
      dev: {
        'file1.s1': 'file1',
        'file2.s1': 'file2',
        'file3.s2': 'file3',
        'file1.s1.s1b': 'file1',
        'file2.s1.s1b': 'file2',
      },
    },
    results: {
      jobs: 5,
    },
  }, {
    name: 'mod s1',
    tasks: ['s2', 's1b'],
    ops: {
      add: {
        'file2.s1': 'file2b',
      },
    },
    outputs: {
      dev: {
        'file1.s1': 'file1',
        'file2.s1': 'file2b',
        'file3.s2': 'file3',
        'file1.s1.s1b': 'file1',
        'file2.s1.s1b': 'file2b',
      },
    },
    results: {
      jobs: 2,
    },
  }, {
    name: 'mod s2',
    tasks: ['s2', 's1b'],
    ops: {
      add: {
        'file3.s2': 'file3b',
      },
    },
    outputs: {
      dev: {
        'file1.s1': 'file1',
        'file2.s1': 'file2b',
        'file3.s2': 'file3b',
        'file1.s1.s1b': 'file1',
        'file2.s1.s1b': 'file2b',
      },
    },
    results: {
      jobs: 1,
    },
  }]),
]);
