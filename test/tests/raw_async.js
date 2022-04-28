// Note: some manual cleaning of test/work/ currently required before running these

const assert = require('assert');
// const gb = require('glov-build');
const gb = require('../../');
const fs = require('fs');
const path = require('path');

const { configure, STATE_DIR, WORK_DIR, atlas, targets } = require('./test_tasks.js');

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
  //writeFile('cpu1sA/a', `f${Math.random()}`);
  //writeFile('cpu1sB/f', 'f');

  if (!'test abort') {
    writeFile('cpu1sA/a', `f${Math.random()}`);
    writeFile('cpu1sA/b', `f${Math.random()}`);
    setTimeout(function () {
      writeFile('cpu1sA/a', `f${Math.random()}`);
    }, 500);
  }
  if ('test atlas') {
    // Manual clean
    let out_file = path.join(targets.dev, 'my_atlas.txt');
    if (fs.existsSync(out_file)) {
      fs.unlinkSync(out_file);
    }
    let atlas_state = path.join(STATE_DIR, 'tasks/atlas/state.json');
    if (fs.existsSync(atlas_state)) {
      fs.unlinkSync(atlas_state);
    }
    // Do atlas
    writeFile('atlas/atlas1.json', `{
  "output": "my_atlas.txt",
  "inputs": [ "txt/file1.txt", "txt/file2.txt"]
}`);
    writeFile('txt/file1.txt', 'file1');
    writeFile('txt/file2.txt', 'file2');
    setTimeout(function () {
      let data = fs.readFileSync(out_file, 'utf8');
      assert.equal(data, 'file1file2');
      console.log('Data checks out 1/2');
      writeFile('txt/file1.txt', 'file1b');
    }, 500);
    setTimeout(function () {
      let data = fs.readFileSync(out_file, 'utf8');
      assert.equal(data, 'file1bfile2');
      console.log('Data checks out 2/2');
    }, 1000);
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
  name: 'atlas',
  input: 'atlas/*.json',
  type: gb.SINGLE,
  target: 'dev',
  async: gb.ASYNC_FORK,
  func: atlas,
  version: Date.now(),
});
gb.task({
  name: 'default',
  deps: ['atlas', 'cpu1sA', 'cpu1sB'],
});
gb.go();
