// const gb = require('glov-build');
const gb = require('../../');
const { doTestList, multiTest } = require('./test_runner.js');

const { cpu_ops_x2, elapsedRange, register } = require('./test_async.js');

doTestList([

  // Note: only one test per file for forked async tasks currently, cannot re-register!

  multiTest({ watch: true, register: register.bind(null, gb.ASYNC_FORK) }, [{
    name: 'CPU 1s x2 async-fork (2x speedup)',
    ...cpu_ops_x2,
    results: {
      checks: [elapsedRange(1000, 1500)],
      jobs: 2,
    },
  }]),

  // TODO: One inproc CPU task and one forked CPU task

]);
