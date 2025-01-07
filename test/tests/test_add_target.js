const path = require('path');
// const gb = require('glov-build');
const gb = require('../../');
const { doTestList, multiTest } = require('./test_runner.js');

const { configure } = require('./test_tasks.js');

function copy(job, done) {
  job.out(job.getFile());
  done();
}


function register() {
  configure();

  gb.task({
    name: 'copy1',
    input: '*.txt',
    type: gb.SINGLE,
    target: 'dev',
    func: copy,
  });

  gb.addTarget('new', path.join(__dirname, '../out/test1/new'));

  gb.task({
    name: 'copy2',
    input: '*.txt',
    type: gb.SINGLE,
    target: 'new',
    func: copy,
  });
}

doTestList([
  multiTest({ watch: true, serial: true, register }, [{
    name: 'initial',
    tasks: ['copy1', 'copy2'],
    ops: {
      add: {
        'file1.txt': 'file1',
      }
    },
    outputs: {
      dev: {
        'file1.txt': 'file1',
      },
      new: {
        'file1.txt': 'file1',
      },
    },
    results: {
      jobs: 2,
    },
  }]),
]);
