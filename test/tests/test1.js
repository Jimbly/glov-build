const assert = require('assert');
const async = require('async');
const chalk = require('chalk');
const fs = require('fs');
// const gb = require('glovjs-build');
const gb = require('../../');
const path = require('path');
const rimraf = require('rimraf');
const readdirRecursive = require('recursive-readdir-synchronous');
const { forwardSlashes } = require('../../lib/util.js');

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
  let {
    tasklist, ops, outputs, name, checks,
    warnings, errors, jobs, files_updated, files_deleted,
  } = opts;
  testUpdateFS(name, ops || {});
  gb.go(tasklist);

  gb.once('done', function (err) {
    testLog(name, 'Build complete! Checking...');
    if (err) {
      assert(process.exitCode);
      process.exitCode = 0;
    }
    assert.equal(gb.stats.jobs, jobs || 0, 'Unexpected number of jobs ran');
    assert.equal(gb.stats.errors, errors || 0, 'Unexpected number of errors');
    assert.equal(gb.stats.warnings, warnings || 0, 'Unexpected number of warnings');
    if (files_updated !== undefined) {
      assert.equal(gb.stats.files_updated, files_updated || 0, 'Unexpected number of files_updated');
    }
    if (files_deleted !== undefined) {
      assert.equal(gb.stats.files_deleted, files_deleted || 0, 'Unexpected number of files_deleted');
    }
    if (errors) {
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
      let target_output = (outputs || {})[target] || {};
      let found_keys = {};
      let target_dir = targets[target];
      let files = fs.existsSync(target_dir) ? readdirRecursive(target_dir) : [];
      for (let ii = 0; ii < files.length; ++ii) {
        let full_path = forwardSlashes(files[ii]);
        let key = forwardSlashes(path.relative(target_dir, full_path));
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
    testLog(name, 'Success');
    gb.stop(next);
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
    errors: 1,
    warnings: 1,
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
        'my_atlas.txt': 'file2', // still output even with error; good idea? up to task?
        // 'txt/file1.txt': 'file1', // pruned
        'txt/file2.txt': 'file2',
      },
    },
    errors: 1,
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
    jobs: 1,
  }),
  test.bind(null, {
    name: 'multiout (2)',
    tasklist: ['clean', 'multiout'],
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
        'multi1-a.txt': 'm1a',
        'multi1-b.txt': 'm1b',
      },
    },
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
        'multi1-a.txt': 'm1a',
      },
    },
    jobs: 1,
  }),
  // Warning tests
  test.bind(null, {
    name: 'warns: initial',
    tasklist: ['clean', 'warns'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    warnings: 1,
    jobs: 2,
  }),
  test.bind(null, {
    name: 'warns: no change',
    tasklist: ['warns'],
    warnings: 1, // still warns
    jobs: 1, // re-runs warned job
  }),
  test.bind(null, {
    name: 'warns: change other',
    tasklist: ['warns'],
    ops: {
      add: {
        'txt/file1.txt': 'file1b',
      }
    },
    warnings: 1, // still warns
    jobs: 2, // re-runs warned job and new
  }),
  test.bind(null, {
    name: 'warns: no change',
    tasklist: ['warns'],
    ops: {
      del: [
        'txt/file2.txt',
      ]
    },
    warnings: 0, // warning removed
    jobs: 0,
  }),

  // warning/error handling tests and updated files counts in a task with deps
  test.bind(null, {
    name: 'atlaswarn: initial',
    tasklist: ['clean', 'atlas'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "txt/file1.txt", "txt/file2.txt"]
}`,
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1file2',
      },
    },
    files_updated: 3,
    warnings: 0,
    jobs: 1,
  }),
  test.bind(null, {
    name: 'atlaswarn: one change',
    tasklist: ['atlas'],
    ops: {
      add: {
        'txt/file2.txt': 'file2b',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1file2b',
      },
    },
    files_updated: 3, // should be 1 if this was run-time, but we're doing a new `go()`
    warnings: 0,
    jobs: 1,
  }),
  test.bind(null, {
    name: 'atlaswarn: file1 warns',
    tasklist: ['atlas'],
    ops: {
      add: {
        'txt/file1.txt': 'warn',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'warnfile2b',
      },
    },
    files_updated: 3, // should be 1 if this was run-time, but we're doing a new `go()`
    warnings: 1,
    jobs: 1,
  }),
  test.bind(null, {
    name: 'atlaswarn: change file2, file1 still warns',
    tasklist: ['atlas'],
    ops: {
      add: {
        'txt/file2.txt': 'file2c',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'warnfile2c',
      },
    },
    files_updated: 3, // should be 2 if this was run-time, but we're doing a new `go()`
    warnings: 1,
    jobs: 1,
  }),
  test.bind(null, {
    name: 'atlaswarn: file1 fixed',
    tasklist: ['atlas'],
    ops: {
      add: {
        'txt/file1.txt': 'file1b',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1bfile2c',
      },
    },
    files_updated: 3, // should be 1 if this was run-time, but we're doing a new `go()`
    warnings: 0,
    jobs: 1,
  }),
  test.bind(null, {
    name: 'atlaswarn: no change',
    tasklist: ['atlas'],
    outputs: {
      dev: {
        'my_atlas.txt': 'file1bfile2c',
      },
    },
    files_updated: 0,
    warnings: 0,
    jobs: 0,
  }),
], function (err) {
  if (err) {
    throw err;
  }
  finished = true;
});
