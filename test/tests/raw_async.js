// const gb = require('glov-build');
const gb = require('../../');
const fs = require('fs');
const path = require('path');

const { configure, WORK_DIR } = require('./test_tasks.js');

// Test inputs setup
function writeFile(key, data) {
  let full_path = path.join(WORK_DIR, key);
  let dirname = path.dirname(full_path);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
  fs.writeFileSync(full_path, data);
}

if (!gb.isFork()) {
  writeFile('cpu1sA/a', `f${Math.random()}`);
  //writeFile('cpu1sB/f', 'f');

  if ('test abort') {
    writeFile('cpu1sA/a', `f${Math.random()}`);
    writeFile('cpu1sA/b', `f${Math.random()}`);
    setTimeout(function () {
      writeFile('cpu1sA/a', `f${Math.random()}`);
    }, 500);
  }

}


// Actual build script

function delayCPU(delay) {
  return function (job, done) {
    job.debug('Starting delay');
    let start = Date.now();
    while (Date.now() - start < delay); // eslint-disable-line curly
    job.debug('Delay finished');
    job.out(job.getFile());
    done();
  };
}

configure({
  parallel: { // current defaults, but assumed for these tests
    tasks: 1,
    tasks_async: 8,
    jobs: 4,
    jobs_async: 8,
  },
  watch: true,
});

gb.task({
  name: 'cpu1sA',
  input: 'cpu1sA/*',
  type: gb.SINGLE,
  target: 'dev',
  async: gb.ASYNC_FORK,
  func: delayCPU(1000),
  version: Date.now(),
});
gb.task({
  name: 'cpu1sB',
  input: 'cpu1sB/*',
  type: gb.SINGLE,
  target: 'dev',
  async: gb.ASYNC_FORK,
  func: delayCPU(1000),
  version: Date.now(),
});
gb.task({
  name: 'default',
  deps: ['cpu1sA', 'cpu1sB'],
});
gb.go();

