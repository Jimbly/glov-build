exports.multiTest = multiTest;
exports.doTestList = doTestList;

const assert = require('assert');
const { asyncSeries } = require('glov-async');
const chalk = require('chalk');
const fs = require('fs');
// const gb = require('glov-build');
const gb = require('../../');
const path = require('path');
const rimraf = require('rimraf');
const readdirRecursive = require('recursive-readdir-synchronous');
const { forwardSlashes } = require('../../lib/util.js');

const {
  targets, STATE_DIR, WORK_DIR,
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
  asyncSeries(tasks, next);
}

let gb_running = false;
function testShutdown(next) {
  assert(gb_running);
  gb_running = false;
  gb.stop(next);
  process.exitCode = 0;
}

function testReset(next) {
  testClean(function () {
    next();
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
  (ops.func || []).forEach(function (fn) {
    try {
      fn(WORK_DIR);
    } catch (e) {
      console.log(e);
      throw e;
    }
  });
  for (let key in ops.delayed) {
    let time = Number(key);
    setTimeout(testUpdateFS.bind(null, `${name}:delayed:${key}`, ops.delayed[key]), time);
  }
}

function test(multi_opts, opts, next) {
  let { watch } = multi_opts;
  let {
    tasks, ops, outputs, name, results, results_abort, phase_delays,
  } = opts;

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
    next();
  }

  function init(next) {
    testLog(name, 'Initializing...');
    setTimeout(() => {
      testUpdateFS(name, ops || {});
      next();
    }, 55); // > 50ms to avoid throttling in chokidar
  }

  function checkResultsSub(label, stats, result_set) {
    let {
      warnings, errors, jobs, files_updated, files_deleted, phase_inputs, phase_deps, phase_run,
    } = result_set;
    assert.equal(stats.jobs, jobs || 0, `${label}Unexpected number of jobs ran`);
    assert.equal(stats.errors, errors || 0, `${label}Unexpected number of errors`);
    assert.equal(stats.warnings, warnings || 0, `${label}Unexpected number of warnings`);
    if (files_updated !== undefined) {
      assert.equal(stats.files_updated, files_updated || 0, `${label}Unexpected number of files_updated`);
    }
    if (files_deleted !== undefined) {
      assert.equal(stats.files_deleted, files_deleted || 0, `${label}Unexpected number of files_deleted`);
    }
    if (phase_inputs !== undefined) {
      assert.equal(stats.phase_inputs, phase_inputs || 0, `${label}Unexpected number of phase_inputs`);
    }
    if (phase_deps !== undefined) {
      assert.equal(stats.phase_deps, phase_deps || 0, `${label}Unexpected number of phase_deps`);
    }
    if (phase_run !== undefined) {
      assert.equal(stats.phase_run, phase_run || 0, `${label}Unexpected number of phase_run`);
    }
  }

  function checkResults(err) {
    if (err) {
      assert(process.exitCode);
    } else {
      assert(!process.exitCode);
    }
    if (results_abort) {
      if (!gb.stats_upon_last_abort) {
        assert(false, 'Expected stats_upon_last_abort, but found none - abort never happened');
      } else {
        checkResultsSub('During abort: ', gb.stats_upon_last_abort, results_abort);
      }
    }
    checkResultsSub('', gb.stats, results);
    let {
      checks, errors,
      fs_read, fs_write, fs_stat, fs_delete,
    } = results;
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
      assert(!err || err.indexOf('spurious') !== -1, 'Expected build to end without error');
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
        assert(target_output[key] !== undefined, `Found unexpected ${target}:${key}`);
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

  gb.setDelays(phase_delays);
  if (gb_running) {
    gb.setActiveTasks(tasks);
    gb.resetStats();
  }
  gb.once('done', onDone);
  init(function () {
    if (!gb_running) {
      gb_running = true;
      gb.go({
        tasks,
        watch,
      });
    }
    onDone();
  });
}

function multiTest(opts, list) {
  return function (next) {
    let { watch, serial } = opts;
    function doRegisterTasks(func, next) {
      func = func || registerTasks;
      func();
      next();
    }
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
        if (ii === 0 || key !== 'watch' || base.reset) {
          tasks.push(doRegisterTasks.bind(null, base.register || opts.register));
        }
        let multi_opts_use = multi_opts;
        if (list[ii + 1] && list[ii + 1].reset) {
          multi_opts_use = {
            ...multi_opts,
            watch: false,
          };
        }
        tasks.push(test.bind(null, multi_opts_use, entry));
        if (ii === list.length - 1 || key !== 'watch' || list[ii + 1] && list[ii + 1].reset) {
          tasks.push(testShutdown);
        }
      }
    }
    if (watch) {
      addKey('watch', { watch: true });
    }
    if (serial) {
      addKey('serial', {});
    }
    assert(tasks.length);
    asyncSeries(tasks, next);
  };
}

function doTestList(list) {
  function onExit() {
    assert(false, 'Process exited before all tests finished');
  }
  process.on('exit', onExit);
  asyncSeries(list, function (err) {
    process.removeListener('exit', onExit);
    if (err) {
      throw err;
    }
  });
}
