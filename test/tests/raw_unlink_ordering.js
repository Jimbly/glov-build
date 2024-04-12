// Tests Photoshop saving behavior that was causing a bug

// bug flow:
// file is processed
// file is touched with new timestamp/contents, build starts
// file is unlinked, triggering abort, then re-added with same timestamp, only unlink goes through

// const gb = require('glov-build');
const gb = require('../../');
const { asyncSeries } = require('glov-async');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { WORK_DIR, targets, registerTasks } = require('./test_tasks.js');

registerTasks();

gb.go({
  tasks: ['clean'],
  watch: false,
});

// Test inputs setup
function writeFile(key, data) {
  let full_path = path.join(WORK_DIR, key);
  let dirname = path.dirname(full_path);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
  fs.writeFileSync(full_path, data);
}

function delay(ms) {
  return (next) => {
    setTimeout(next, ms);
  };
}

gb.once('done', gb.stop.bind(gb, function () {
  writeFile('txt/file1.txt', 'file1');

  registerTasks();

  gb.task({
    name: 'slowcopy',
    input: 'txt/*.txt',
    type: gb.SINGLE,
    target: 'dev',
    func: function (job, done) {
      setTimeout(function () {
        job.out(job.getFile());
        done();
      }, 500);
    }
  });

  gb.go({
    tasks: ['slowcopy'],
    watch: true,
  });

  let filename = `${WORK_DIR}/txt/file1.txt`;
  gb.once('done', function () {
    let test_stat;

    asyncSeries([
      function (next) {
        console.log('writing update');
        writeFile('txt/file1.txt', 'file1b');
        next();
      },
      delay(250),
      function (next) {
        console.log('unlinking');
        test_stat = fs.statSync(filename);
        fs.unlinkSync(filename);
        next();
      },
      delay(100),
      function (next) {
        console.log('writing replacement');
        writeFile('txt/file1.txt', 'file1b');
        fs.utimesSync(filename, test_stat.atime, test_stat.mtime);
        next();
      },
    ], function () {
      setTimeout(function () {
        let out_file = path.join(targets.dev, 'txt/file1.txt');
        let data = fs.readFileSync(out_file, 'utf8');
        assert.equal(data, 'file1b');
        console.log('Data checks out 1/1');
        gb.stop();
      }, 1000);
    });
  });
}));
