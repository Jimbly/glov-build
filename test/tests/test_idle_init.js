const assert = require('assert');
// const gb = require('glov-build');
const gb = require('../../');
const { doTestList, multiTest, testShutdown } = require('./test_runner.js');

const { configure } = require('./test_tasks.js');

function copy(job, done) {
  job.out(job.getFile());
  done();
}

let s1_inited;
let s2_inited;

function s1IsInited(expected) {
  return function () {
    assert.equal(s1_inited, expected);
  };
}

function s2IsInited(expected) {
  return function () {
    assert.equal(s2_inited, expected);
  };
}

function register() {
  configure();

  s1_inited = false;
  s2_inited = false;
  gb.task({
    name: 's1',
    input: '*.s1',
    type: gb.SINGLE,
    target: 'dev',
    init: (done) => {
      s1_inited = true;
      done();
    },
    func: copy,
  });

  gb.task({
    name: 's2',
    input: '*.s2',
    type: gb.SINGLE,
    target: 'dev',
    init: (done) => {
      s2_inited = true;
      done();
    },
    func: copy,
  });
}

doTestList([
  multiTest({ watch: true, no_stop: true, register }, [{
    name: 'initial',
    tasks: ['s1', 's2'],
    ops: {
      add: {
        'file1.s1': 'file1',
      }
    },
    outputs: {
      dev: {
        'file1.s1': 'file1',
      },
    },
    results: {
      checks: [s1IsInited(true), s2IsInited(false)],
      jobs: 1,
    },
  }, {
    name: 'mod s1',
    tasks: ['s1', 's2'],
    ops: {
      add: {
        'file1.s1': 'file1b',
      },
    },
    outputs: {
      dev: {
        'file1.s1': 'file1b',
      },
    },
    results: {
      checks: [s1IsInited(true), s2IsInited(false)],
      jobs: 1,
    },
  }]),
], function () {
  assert(!s2_inited);
  setTimeout(function () {
    assert(s2_inited);
    // shutdown
    testShutdown();
  }, 250);
});
