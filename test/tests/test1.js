const assert = require('assert');
const async = require('async');
const chalk = require('chalk');
const fs = require('fs');
// const gb = require('glovjs-build');
const gb = require('../../');
const path = require('path');
const rimraf = require('rimraf');
const readdirRecursive = require('recursive-readdir-synchronous');

const { targets, STATE_DIR, WORK_DIR, didRun } = require('./test_tasks.js');

function testLog(name, str) {
  console.log(chalk.cyan.bold(`TEST(${name}): ${str}`));
}
function testClean(next) {
  function clean(dir, next) {
    testLog('clean', `Cleaning ${dir}...`);
    rimraf(dir, next);
  }
  let tasks = [
    clean.bind(null, WORK_DIR),
    clean.bind(null, STATE_DIR),
  ];
  for (let key in targets) {
    tasks.push(clean.bind(null, targets[key]));
  }
  async.series(tasks, next);
}

function testUpdateFS(name, ops) {
  let madedirs = {};
  for (let key in ops.add) {
    let full_path = path.join(WORK_DIR, key);
    let dirname = path.dirname(full_path);
    if (!madedirs[dirname]) {
      madedirs[dirname] = true;
      if (!fs.existsSync(dirname)) {
        testLog(name, `Making ${dirname}...`);
        fs.mkdirSync(dirname, { recursive: true });
      }
    }
    fs.writeFileSync(full_path, ops.add[key]);
  }
  if (ops.del) {
    for (let ii = 0; ii < ops.del.length; ++ii) {
      let full_path = path.join(WORK_DIR, ops.del[ii]);
      fs.unlinkSync(full_path);
    }
  }
}

function test(opts, next) {
  let { tasklist, ops, outputs, name, checks, expect_error, jobs } = opts;
  testUpdateFS(name, ops);
  gb.go(tasklist);

  gb.once('done', function (err) {
    testLog(name, 'Build complete! Checking...');
    if (err) {
      assert(process.exitCode);
      process.exitCode = 0;
    }
    if (expect_error) {
      assert(err, 'Expected build to end in error');
    } else {
      assert(!err, 'Expected build to end without error');
    }
    if (checks) {
      for (let ii = 0; ii < checks.length; ++ii) {
        checks[ii]();
      }
    }

    for (let target in targets) {
      let target_output = outputs[target];
      let found_keys = {};
      let target_dir = targets[target];
      let files = readdirRecursive(target_dir);
      for (let ii = 0; ii < files.length; ++ii) {
        let full_path = files[ii].replace(/\\/g, '/');
        let key = path.relative(target_dir, full_path).replace(/\\/g, '/');
        assert(target_output[key], `Found unexpected ${target}:${key}`);
        let found = fs.readFileSync(full_path, 'utf8');
        assert.equal(found, target_output[key], `Mismatched data in ${target}:${key}`);
        found_keys[key] = true;
      }
      for (let key in target_output) {
        if (!found_keys[key]) {
          assert(false, `Missing expected ${target}:${key}`);
        }
      }
    }
    assert.equal(gb.stats.jobs, jobs, 'Unexpected number of jobs ran');
    testLog(name, 'Success');
    gb.stop();
    next();
  });
}

let finished = false;
process.on('exit', function () {
  assert(finished, 'Process exited before all tests finished');
});
async.series([
  testClean,
  test.bind(null, {
    name: 'initial',
    tasklist: ['default'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "txt/file1.txt", "txt/file2.txt"]
}`,
        'txt/file1.asc': 'ascii1',
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'concat.txt': 'ascii1file1file2',
        'concat-reverse.txt': '1elif2elif',
        'my_atlas.txt': 'file1file2',
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    checks: [
      didRun,
    ],
    expect_error: true,
    jobs: 12,
  }),
  test.bind(null, {
    name: 'delete 1',
    tasklist: ['reduced'],
    ops: {
      del: [
        'txt/file1.txt'
      ]
    },
    outputs: {
      dev: {
        'concat.txt': 'ascii1file2',
        'concat-reverse.txt': '2elif',
        // 'my_atlas.txt': 'file1file2', // pruned with error; good idea?
        // 'txt/file1.txt': 'file1', // pruned
        'txt/file2.txt': 'file2',
      },
    },
    expect_error: true,
    jobs: 3,
  }),
  test.bind(null, {
    name: 'fix atlas',
    tasklist: ['reduced'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "txt/file2.txt"]
}`,
      }
    },
    outputs: {
      dev: {
        'concat.txt': 'ascii1file2',
        'concat-reverse.txt': '2elif',
        'my_atlas.txt': 'file2', // updated
        // 'txt/file1.txt': 'file1', // pruned
        'txt/file2.txt': 'file2',
      },
    },
    expect_error: false,
    jobs: 1,
  }),
  test.bind(null, {
    name: 'multiout (2)',
    tasklist: ['multiout'],
    ops: {
      add: {
        'multi/multi1.json':
`{
  "outputs": {
    "multi1-a.txt": "m1a",
    "multi1-b.txt": "m1b"
  }
}`,
      }
    },
    outputs: {
      dev: {
        'concat.txt': 'ascii1file2',
        'concat-reverse.txt': '2elif',
        'my_atlas.txt': 'file2',
        'txt/file2.txt': 'file2',
        'multi1-a.txt': 'm1a',
        'multi1-b.txt': 'm1b',
      },
    },
    expect_error: false,
    jobs: 1,
  }),
  test.bind(null, {
    name: 'multiout (1)',
    tasklist: ['multiout'],
    ops: {
      add: {
        'multi/multi1.json':
`{
  "outputs": {
    "multi1-a.txt": "m1a"
  }
}`,
      }
    },
    outputs: {
      dev: {
        'concat.txt': 'ascii1file2',
        'concat-reverse.txt': '2elif',
        'my_atlas.txt': 'file2',
        'txt/file2.txt': 'file2',
        'multi1-a.txt': 'm1a'
      },
    },
    expect_error: false,
    jobs: 1,
  }),

], function (err) {
  if (err) {
    throw err;
  }
  finished = true;
});
