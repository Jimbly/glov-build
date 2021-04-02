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

const {
  targets, STATE_DIR, WORK_DIR,
  didRun, atlasLastReset, atlasLastNotReset,
  registerTasks,
} = require('./test_tasks.js');

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

let gb_running = false;
function testShutdown(next) {
  if (gb_running) {
    gb_running = false;
    gb.stop(next);
  } else {
    next();
  }
}

function testReset(next) {
  testShutdown(function () {
    testClean(function () {
      next();
    });
  });
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
  (ops.del || []).forEach(function (relative) {
    let full_path = path.join(WORK_DIR, relative);
    fs.unlinkSync(full_path);
  });
  (ops.spurious || []).forEach(function (relative) {
    let full_path = path.join(WORK_DIR, relative);
    let stat = fs.statSync(full_path);
    fs.utimesSync(full_path, stat.atime, stat.mtime);
  });
}

function test(multi_opts, opts, next) {
  let { watch } = multi_opts;
  let {
    tasklist, ops, outputs, name, results,
  } = opts;
  let {
    checks,
    warnings, errors, jobs, files_updated, files_deleted,
    fs_read, fs_write, fs_stat, fs_delete,
  } = results;

  let left = 2;
  let got_err;
  function onDone(err) {
    got_err = got_err || err;
    if (--left) {
      return;
    }
    testLog(name, 'Build complete! Checking...');
    checkResults(got_err);
    // TODO: catch if this fails, re-register 'done' and wait 1 second before
    //   timing out and trying again without a try/catch?
    testLog(name, 'Success');
    if (!watch) {
      testShutdown(next);
    } else {
      next();
    }
  }

  function init(next) {
    testLog(name, 'Initializing...');
    setTimeout(() => {
      testUpdateFS(name, ops || {});
      next();
    }, 55); // > 50ms to avoid throttling in chokidar
  }

  function checkResults(err) {
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
    if (fs_read !== undefined) {
      assert.equal(gb.files.stats.read, fs_read || 0, 'Unexpected number of fs.read');
    }
    if (fs_write !== undefined) {
      assert.equal(gb.files.stats.write, fs_write || 0, 'Unexpected number of fs.write');
    }
    if (fs_stat !== undefined) {
      assert.equal(gb.files.stats.stat, fs_stat || 0, 'Unexpected number of fs.stat');
    }
    if (fs_delete !== undefined) {
      assert.equal(gb.files.stats.delete, fs_delete || 0, 'Unexpected number of fs.delete');
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
  }

  if (gb_running) {
    gb.setActiveTasks(tasklist);
    gb.resetStats();
  } else {
    registerTasks();
  }
  gb.once('done', onDone);
  init(function () {
    if (!gb_running) {
      gb_running = true;
      gb.go({
        tasks: tasklist,
        watch,
      });
    }
    onDone();
  });
}

function multiTest(opts, list) {
  return function (next) {
    let tasks = [];
    let orig_name = list.map((a) => a.name);
    function addKey(key, multi_opts) {
      let result_key = `results_${key}`;
      tasks.push(testReset);
      for (let ii = 0; ii < list.length; ++ii) {
        let base = list[ii];
        let results = {
          ...(base.results || {}),
          ...(base[result_key] || {}),
        };
        let entry = {
          ...base,
          results,
          name: `${key}:${orig_name[ii]}`,
        };
        tasks.push(test.bind(null, multi_opts, entry));
      }
    }
    if (opts.watch) {
      addKey('watch', { watch: true });
    }
    if (opts.serial) {
      addKey('serial', {});
    }
    assert(tasks.length);
    async.series(tasks, next);
  };
}

let finished = false;
process.on('exit', function () {
  assert(finished, 'Process exited before all tests finished');
});
async.series([
  multiTest({ watch: true, serial: true }, [{
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
    results: { // same for both
      checks: [
        didRun,
        atlasLastReset,
      ],
      fs_read: 4,
      fs_write: 7,
      fs_stat: 4,
      fs_delete: 0,
      errors: 1,
      warnings: 1,
      jobs: 12,
    },
  }, {
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
    results: {
      fs_write: 3,
      fs_delete: 2,
      jobs: 3,
      errors: 1,
    },
    results_watch: {
      checks: [atlasLastNotReset],
      fs_read: 0,
      fs_stat: 0,
    },
    results_serial: {
      checks: [atlasLastReset],
      fs_read: 4,
      fs_stat: 10, // was once 9?
    },
  }, {
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
    results: {
      checks: [atlasLastReset],
      fs_write: 1,
      fs_delete: 0,
      jobs: 1,
    },
    results_watch: {
      fs_read: 1,
      fs_stat: 0,
    },
    results_serial: {
      fs_read: 2,
      fs_stat: 7,
    },
  }, {
    name: 'broken atlas again',
    tasklist: ['reduced'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "txt/file1.txt", "txt/file2.txt"]
}`,
      }
    },
    outputs: {
      dev: {
        'concat.txt': 'ascii1file2',
        'concat-reverse.txt': '2elif',
        'my_atlas.txt': 'file2',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      checks: [atlasLastReset],
      fs_write: 1,
      fs_delete: 0,
      errors: 1,
      warnings: 0,
      jobs: 1,
    },
    results_watch: {
      fs_read: 1,
      fs_stat: 0,
    },
    results_serial: {
      fs_read: 2,
      fs_stat: 8,
    },
  }, {
    name: 'fix by re-adding deleted file',
    tasklist: ['reduced'],
    ops: {
      add: {
        'txt/file1.txt': 'file1b',
      }
    },
    outputs: {
      dev: {
        'concat.txt': 'ascii1file1bfile2',
        'concat-reverse.txt': 'b1elif2elif',
        'my_atlas.txt': 'file1bfile2',
        'txt/file1.txt': 'file1b',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      fs_write: 5,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 5,
    },
    results_watch: {
      checks: [atlasLastNotReset],
      fs_read: 1,
      fs_stat: 0,
    },
    results_serial: {
      checks: [atlasLastReset],
      fs_read: 5,
      fs_stat: 6,
    },
  }]),

  // Atlas dynamic reprocessing and caching
  multiTest({ watch: true, serial: true }, [{
    name: 'atlas dynamic reset',
    tasklist: ['atlas'],
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
    results: {
      checks: [atlasLastReset],
      fs_read: 3,
      fs_write: 1,
      fs_stat: 3,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 1,
    },
  }, {
    name: 'atlas dynamic mod',
    tasklist: ['atlas'],
    ops: {
      add: {
        'txt/file1.txt': 'file1a',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1afile2',
      },
    },
    results: {
      fs_write: 1,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 1,
    },
    results_watch: {
      checks: [atlasLastNotReset],
      fs_read: 1,
      fs_stat: 0,
    },
    results_serial: {
      checks: [atlasLastReset],
    },
  }, {
    name: 'spurious change',
    tasklist: ['atlas'],
    ops: {
      spurious: [
        'txt/file1.txt',
      ]
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1afile2',
      },
    },
    results: {
      fs_read: 0,
      fs_write: 0,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 0,
    },
    results_watch: {
      fs_stat: 0,
    },
    results_serial: {
      fs_stat: 4,
    },
  }]),

  multiTest({ watch: true, serial: true }, [{
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
        'multi1-a.txt': 'm1a',
        'multi1-b.txt': 'm1b',
      },
    },
    results: {
      jobs: 1,
    },
  }, {
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
    results: {
      jobs: 1,
    },
  }]),

  // Warning tests
  multiTest({ watch: true, serial: true }, [{
    name: 'warns: initial',
    tasklist: ['warns'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    results: {
      warnings: 1,
      jobs: 2,
    },
  }, {
    name: 'warns: no change',
    tasklist: ['warns'],
    ops: {
      spurious: [
        'txt/file1.txt',
      ]
    },
    results_watch: {
      warnings: 0, // spurious changes causes nothing to happen while watching
      jobs: 0,
    },
    results_serial: {
      warnings: 1, // re-emits warning if running fresh
      jobs: 1, // re-runs the job to be safe
    },
  }, {
    name: 'warns: change other',
    tasklist: ['warns'],
    ops: {
      add: {
        'txt/file1.txt': 'file1b',
      }
    },
    results: {
      warnings: 1, // still warns
    },
    results_watch: {
      jobs: 1, // runs only new job
    },
    results_serial: {
      jobs: 2, // also re-runs job that previously warned
    },
  }, {
    name: 'warns: delete bad',
    tasklist: ['warns'],
    ops: {
      del: [
        'txt/file2.txt',
      ]
    },
    results: {
      warnings: 0, // warning removed
      jobs: 0,
    },
  }]),

  // warning/error handling tests and updated files counts in a task with deps
  multiTest({ watch: true, serial: true }, [{
    name: 'atlaswarn: initial',
    tasklist: ['atlas'],
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
    results: {
      files_updated: 3,
      fs_write: 1,
      warnings: 0,
      jobs: 1,
    },
  }, {
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
    results: {
      warnings: 0,
      jobs: 1,
    },
    results_watch: {
      files_updated: 1, // only one file shows as "updated"
    },
    results_serial: {
      files_updated: 3, // all files show as "updated" in a new process
    },
  }, {
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
    results: {
      warnings: 1,
      jobs: 1,
    },
    results_watch: {
      files_updated: 1, // only one file shows as "updated"
    },
    results_serial: {
      files_updated: 3, // all files show as "updated" in a new process
    },
  }, {
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
    results: {
      warnings: 1,
      jobs: 1,
    },
    results_watch: {
      files_updated: 2,
    },
    results_serial: {
      files_updated: 3,
    },
  }, {
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
    results: {
      warnings: 0,
      jobs: 1,
    },
    results_watch: {
      files_updated: 1, // only one file shows as "updated"
    },
    results_serial: {
      files_updated: 3, // all files show as "updated" in a new process
    },
  }, {
    name: 'atlaswarn: no change',
    tasklist: ['atlas'],
    ops: {
      spurious: [
        'txt/file1.txt',
      ]
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1bfile2c',
      },
    },
    results: {
      files_updated: 0,
      warnings: 0,
      jobs: 0,
    },
  }]),
  testShutdown,
], function (err) {
  if (err) {
    throw err;
  }
  finished = true;
});
