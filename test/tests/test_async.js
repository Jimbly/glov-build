const assert = require('assert');
// const gb = require('glov-build');
const gb = require('../../');
const { doTestList, multiTest } = require('./test_runner.js');

const { configure } = require('./test_tasks.js');

function delayIO(delay) {
  return function (job, done) {
    setTimeout(function () {
      job.out(job.getFile());
      done();
    }, delay);
  };
}

function delayCPU(delay) {
  return function (job, done) {
    let start = Date.now();
    while (Date.now() - start < delay); // eslint-disable-line curly
    job.out(job.getFile());
    done();
  };
}


function register(async) {
  configure({
    // parallel: {
    //   tasks: 1,
    //   jobs: 4,
    // },
  });

  gb.task({
    name: 'io1sA',
    input: 'io1sA/*',
    type: gb.SINGLE,
    target: 'dev',
    async: async,
    func: delayIO(1000),
  });

  gb.task({
    name: 'io1sB',
    input: 'io1sB/*',
    type: gb.SINGLE,
    target: 'dev',
    async: async,
    func: delayIO(1000),
  });

  gb.task({
    name: 'cpu1sA',
    input: 'cpu1sA/*',
    type: gb.SINGLE,
    target: 'dev',
    async: async,
    func: delayCPU(1000),
  });
  gb.task({
    name: 'cpu1sB',
    input: 'cpu1sB/*',
    type: gb.SINGLE,
    target: 'dev',
    async: async,
    func: delayCPU(1000),
  });
  gb.task({
    name: 'async',
    deps: ['io1sA', 'io1sB', 'cpu1sA', 'cpu1sB'],
  });
}

let timing_start;
function startTiming() {
  timing_start = Date.now();
}

function seconds(v) {
  return `${(v/1000).toFixed(1)}s`;
}

function elapsedRange(min, max) {
  return function () {
    let dt = Date.now() - timing_start;
    assert(dt >= min && dt <= max, `Expected between ${seconds(min)} and ${seconds(max)} but took ${seconds(dt)}`);
  };
}

const io_ops_x2 = {
  tasks: ['async'],
  ops: {
    add: {
      'io1sA/f': 'f',
      'io1sB/f': 'f',
    },
    func: [startTiming],
  },
  outputs: {
    dev: {
      'io1sA/f': 'f',
      'io1sB/f': 'f',
    },
  },
};

const cpu_ops_x2 = {
  tasks: ['async'],
  ops: {
    add: {
      'cpu1sA/f': 'f',
      'cpu1sB/f': 'f',
    },
    func: [startTiming],
  },
  outputs: {
    dev: {
      'cpu1sA/f': 'f',
      'cpu1sB/f': 'f',
    },
  },
};

doTestList([
  multiTest({ watch: true, register: register.bind(null, gb.ASYNC_DEFAULT) }, [{
    name: 'IO 1s x2',
    ...io_ops_x2,
    results: {
      checks: [elapsedRange(2000, 2500)],
      jobs: 2,
    },
  }]),

  multiTest({ watch: true, register: register.bind(null, gb.ASYNC_INPROC) }, [{
    name: 'IO 1s x2 async (2x speedup)',
    ...io_ops_x2,
    results: {
      checks: [elapsedRange(1000, 1500)],
      jobs: 2,
    },
  }]),

  multiTest({ watch: true, register: register.bind(null, gb.ASYNC_DEFAULT) }, [{
    name: 'CPU 1s x2',
    ...cpu_ops_x2,
    results: {
      checks: [elapsedRange(2000, 2500)],
      jobs: 2,
    },
  }]),

  multiTest({ watch: true, register: register.bind(null, gb.ASYNC_INPROC) }, [{
    name: 'CPU 1s x2 async (no speedup)',
    ...cpu_ops_x2,
    results: {
      checks: [elapsedRange(2000, 2500)],
      jobs: 2,
    },
  }]),

]);
