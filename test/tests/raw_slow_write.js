// Tests working around Chokidar bug that otherwise throttles change events

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

  gb.go({
    tasks: ['copy'],
    watch: true,
  });

  gb.once('done', function () {
    let test_fd;
    asyncSeries([
      function (next) {
        console.log('opening');
        test_fd = fs.openSync(`${WORK_DIR}/txt/file1.txt`, 'w');
        next();
      },
      delay(25),
      function (next) {
        console.log('writing');
        fs.write(test_fd, 'file1b', next);
      },
      function (next) {
        console.log('closing');
        fs.close(test_fd, next);
      },
    ], function () {
      setTimeout(function () {
        let out_file = path.join(targets.dev, 'txt/file1.txt');
        let data = fs.readFileSync(out_file, 'utf8');
        assert.equal(data, 'file1b');
        console.log('Data checks out 1/1');
        gb.stop();
      }, 500);
    });
  });
}));
