const assert = require('assert');
const { asyncEach, asyncEachLimit, asyncEachSeries, asyncLimiter, asyncSeries } = require('glov-async');
const chalk = require('chalk');
const chokidar = require('chokidar');
const crc32 = require('./crc32.js');
const { dumpDepTree } = require('./debug.js');
const { EventEmitter } = require('events');
const fast_glob = require('fast-glob');
const { filesCreate, isBuildFile, DELETED_TIMESTAMP } = require('./files.js');
const { max } = Math;
const micromatch = require('micromatch');
const minimist = require('minimist');
const path = require('path');
const readdirRecursive = require('recursive-readdir');
const { createTaskState } = require('./task_state.js');
const timestamp = require('time-stamp');
const {
  callbackify,
  cmpTaskPhase,
  deleteFileWithRmdir,
  empty,
  forwardSlashes,
  merge,
  ridx,
  unpromisify,
} = require('./util.js');
const util = require('util');

const fg = callbackify(fast_glob);

// general path mapping (all via files.bucket_dirs)
//   foo/bar.baz -> config.source
//   taskname:foo/bar.baz -> task.intdir
//   targetname:foo/bar.baz -> config.targets[targetname]

const STATUS_PENDING = 'pending';
const STATUS_PREPARING_INPUTS = 'inputs';
const STATUS_PREPARING_DEPS = 'deps';
const STATUS_RUNNING = 'running';
const STATUS_DONE = 'done';
const STATUS_ERROR = 'error';
const STATUS_ABORTED = 'aborted';

const STATUS_IS_STOPPED = {};
STATUS_IS_STOPPED[STATUS_PENDING] = true;
STATUS_IS_STOPPED[STATUS_DONE] = true;
STATUS_IS_STOPPED[STATUS_ERROR] = true;
STATUS_IS_STOPPED[STATUS_ABORTED] = true;

const TIME_BEFORE_IDLE_INIT = 100;

const ASYNC_LIMIT = 4;

const ALL = 'all'; // func ran on all inputs at once
const SINGLE = 'single'; // func ran on each input

const LOG_SILLY = 0;
const LOG_DEBUG = 1;
const LOG_INFO = 2;
const LOG_NOTICE = 3;
const LOG_WARN = 4;
const LOG_ERROR = 5;
// const LOG_SILENT = 6;
let log_level = LOG_DEBUG;
let log_timestamp = 'HH:mm:ss';
const LOG_LEVEL_TO_PARAM = [
  'debug',
  'debug',
  'info',
  'info',
  'warn',
  'error',
];
const LOG_LEVEL_TO_COLOR = [
  chalk.gray,
  chalk.gray,
  chalk.white,
  chalk.whiteBright,
  chalk.yellowBright,
  chalk.redBright,
];
const STATE_COLORED = {};
STATE_COLORED[STATUS_PENDING] = chalk.gray(STATUS_PENDING);
STATE_COLORED[STATUS_PREPARING_INPUTS] = chalk.cyan(STATUS_PREPARING_INPUTS);
STATE_COLORED[STATUS_PREPARING_DEPS] = chalk.cyan(STATUS_PREPARING_DEPS);
STATE_COLORED[STATUS_RUNNING] = chalk.blueBright(STATUS_RUNNING);
STATE_COLORED[STATUS_DONE] = chalk.greenBright(STATUS_DONE);
STATE_COLORED[STATUS_ERROR] = chalk.red(STATUS_ERROR);
STATE_COLORED[STATUS_ABORTED] = chalk.gray(STATUS_ABORTED);

const reload = chalk.blue;
const taskname = chalk.cyan;

function log(level, msg, ...args) {
  if (level < log_level) {
    return;
  }
  let fn = LOG_LEVEL_TO_PARAM[level];
  let color = LOG_LEVEL_TO_COLOR[level];
  let header = log_timestamp ? `[${chalk.gray(timestamp(log_timestamp))}] ` : '';
  console[fn](`${header}${color(msg)}`, ...args);
}
const lsilly = log.bind(null, LOG_SILLY);
const ldebug = log.bind(null, LOG_DEBUG);
const linfo = log.bind(null, LOG_INFO);
const lnotice = log.bind(null, LOG_NOTICE);
const lwarn = log.bind(null, LOG_WARN);
const lerror = log.bind(null, LOG_ERROR);

function plural(number, label) {
  return `${number} ${label}${number === 1 ? '' : 's'}`;
}

function GlovBuild() {
  this.reset();
  this.generation = 0;
  this.exit_handler = () => {
    let any_active = false;
    for (let key in this.tasks) {
      let task = this.tasks[key];
      if (task.active &&
        task.status !== STATUS_DONE && task.status !== STATUS_ERROR && task.status !== STATUS_ABORTED
      ) {
        if (!this.watcher) {
          lnotice(`Warning: Task "${taskname(task.name)}" still active (status=${task.status}) upon process exit`);
        }
        any_active = true;
      }
    }
    if (any_active) {
      if (!this.watcher) {
        lnotice('A job or init callback probably failed to signal completion');
      }
      if (!process.exitCode) {
        process.exitCode = 1;
      }
    }
  };
}
util.inherits(GlovBuild, EventEmitter);

// Constants
GlovBuild.prototype.ALL = ALL;
GlovBuild.prototype.SINGLE = SINGLE;
// Logging convenience functions
GlovBuild.prototype.silly = lsilly;
GlovBuild.prototype.debug = ldebug;
GlovBuild.prototype.info = linfo;
GlovBuild.prototype.notice = lnotice;
GlovBuild.prototype.warn = lwarn;
GlovBuild.prototype.error = lerror;

GlovBuild.prototype.LOG_SILLY = LOG_SILLY;
GlovBuild.prototype.LOG_DEBUG = LOG_DEBUG;
GlovBuild.prototype.LOG_INFO = LOG_INFO;
GlovBuild.prototype.LOG_NOTICE = LOG_NOTICE;
GlovBuild.prototype.LOG_WARN = LOG_WARN;
GlovBuild.prototype.LOG_ERROR = LOG_ERROR;

GlovBuild.prototype.reset = function () {
  // Default configuration options
  this.config = {
    root: '.',
    statedir: './.gbstate',
    targets: {},
    watch: false,
    parallel: {
      tasks: 1,
      jobs: 1,
    },
  };
  this.tasks = {};
  this.running = false;
  this.watcher = null;
  this.start_time = Date.now();
  this.last_finish_time = Date.now();
  this.was_all_done = false;
  this.aborting = false;
  this.abort_start_time = null;
  this.fs_all_events = null;
  this.fs_invalidated_tasks = null; // all invalidated tasks
  this.fs_invalidated_tasks_root = null; // those directly invalidated by a file change
  this.delays = {
    inputs_pre: 0,
    inputs_post: 0, // same as deps_pre would be
    deps: 0,
    // task: 0,
    // job: 0,
  };
  this.resetStats();
  //this.resetFiles();
};
GlovBuild.prototype.resetStats = function () {
  this.stats = {
    files_updated: 0,
    warnings: 0,
    errors: 0,
    jobs: 0,
    phase_inputs: 0,
    phase_deps: 0,
    phase_run: 0,
  };
  this.stats_upon_last_abort = null;
  if (this.files) {
    this.files.resetStats();
  }
};


const invalid_file_char = /[/\\'"`$%:]/;

let last_task_uid=0;
function BuildTask(gb, opts) {
  this.gb = gb;
  // Run-time state
  this.phase = 0; // for the UI, where it fits horizontally; how deep is the dep tree to us
  this.uid = ++last_task_uid;
  this.dependors = [];
  this.dependors_active = null; // filtered by active
  this.task_state = null; // task/job state tracking
  this.intdir = null; // intermediate dir, only actually written to if no target specified; taskdir/out
  this.outdir = null; // location for output files, may be intdir or may be a (shared) target
  this.user_data = null;
  this.did_init = false; // Has run init for this execution pass
  this.ever_did_init = false; // Has ever run init for the history of this process
  this.post_init = null;
  this.last_run_time = Date.now();

  // Validate and parse task options
  assert(opts);
  this.name = opts.name;
  this.deps = (opts.deps || []).slice(0);
  this.type = opts.type;
  this.input = opts.input;
  this.func = opts.func;
  this.init = opts.init;
  this.finish = opts.finish;
  this.target = opts.target;
  this.version = opts.version || 0;
  this.read = opts.read !== false;
  if (!this.version && opts.func) {
    // auto-version based on the string representation of the function - only somewhat works
    let text = opts.func.toString();
    if (opts.init) {
      text += opts.init.toString();
    }
    if (opts.finish) {
      text += opts.finish.toString();
    }
    text += `target:${opts.target}`;
    this.version = `CRC#${crc32(text).toString(16)}`;
  }

  assert(this.name, 'Task missing required parameter "name"');
  assert(!this.name.match(invalid_file_char),
    `Task "${taskname(this.name)}": name must be a valid, safe file name (none of /\\'"\`$%:)`);
  assert(Array.isArray(this.deps),
    `Task "${taskname(this.name)}": "deps" must be an Array, found ${typeof this.deps}`);

  let globs_by_bucket = {};
  let self = this;
  function addDep(bucket) {
    if (bucket !== 'source' && self.deps.indexOf(bucket) === -1) {
      self.deps.push(bucket);
    }
  }
  function addSourceGlob(bucket, glob) {
    globs_by_bucket[bucket] = globs_by_bucket[bucket] || [];
    globs_by_bucket[bucket].push(glob);
  }
  if (this.input) {
    if (typeof this.input === 'string') {
      this.input = [this.input];
    }
    assert(Array.isArray(this.input),
      `Task "${taskname(this.name)}": "input" must be null, a string, or an Array, found ${typeof this.input}`);
    assert(this.input.length,
      `Task "${taskname(this.name)}": "input" array must not be empty (omit if task has no inputs)`);
    this.input = this.input.map(forwardSlashes);
    for (let ii = 0; ii < this.input.length; ++ii) {
      let input = this.input[ii];
      assert(typeof input === 'string',
        `Task "${taskname(this.name)}": entries in "input" must be strings, found ${typeof input}`);
      let split = input.split(':');
      assert(split.length <= 2,
        `Task "${taskname(this.name)}": entries in "input" must be of the form ` +
        `"glob" or "task:glob", found "${input}"`);
      if (split.length === 1) {
        addSourceGlob('source', input);
      } else {
        let bucket = split[0];
        let glob = split[1];
        let source_task = gb.tasks[bucket];
        if (source_task && !source_task.input) {
          // it's a meta task, with no function, so, add it's sources as our sources
          assert(!source_task.func);
          assert(source_task.deps.length);
          addDep(bucket);
          for (let jj = 0; jj < source_task.deps.length; ++jj) {
            let dep_task = source_task.deps[jj];
            // important:  also depend directly on the sub-tasks, so that they
            // get us added as a dependor for propagating fs events
            addDep(dep_task.name);
            addSourceGlob(dep_task.name, glob);
          }
        } else {
          addDep(bucket);
          addSourceGlob(bucket, glob);
        }
      }
    }
    this.globs_by_bucket = globs_by_bucket;

    assert(this.type === ALL || this.type === SINGLE,
      `Task "${taskname(this.name)}": "type" must be gb.SINGLE, gb.ALL, found ${this.type}`);

    assert(typeof this.func === 'function',
      `Task "${taskname(this.name)}": "func" must be of type function, found ${typeof this.func}`);

    if (this.target) {
      assert(typeof this.target === 'string',
        `Task "${taskname(this.name)}": "target" must be of type string, found ${typeof this.target}`);
    }
  } else {
    // no input, must at least have deps!
    assert(this.deps && this.deps.length,
      `Task "${taskname(this.name)}": Task must specify at least "deps" or "input"`);

    assert(!this.func,
      `Task "${taskname(this.name)}": A task with no inputs must not specify a "func"`);

    assert(!this.target,
      `Task "${taskname(this.name)}": A task with no inputs must not specify a "target"`);

    this.globs_by_bucket = {};
  }

  for (let ii = 0; ii < this.deps.length; ++ii) {
    let dep_name = this.deps[ii];
    assert(typeof dep_name === 'string',
      `Task "${taskname(this.name)}": entries in "deps" must be strings, found ${typeof dep_name}`);
  }

  this.taskdir = path.join(gb.config.statedir, 'tasks', this.name);
  this.reset();

  this.intdir = path.join(this.taskdir, 'out');
  if (this.target) {
    let targetdir = gb.config.targets[this.target];
    assert(targetdir,
      `Task "${taskname(this.name)}": "target" must be empty or reference a target specified in configure(),` +
      ` found "${this.target}"`);
    this.outdir = targetdir;
    this.bucket_out = this.target;
  } else {
    this.outdir = this.intdir;
    this.bucket_out = this.name;
  }
}

BuildTask.prototype.reset = function () {
  this.active = false; // depended on by an a active task
  this.status = STATUS_PENDING;
  this.last_time = Date.now();
  this.err = null;
  this.task_state = createTaskState({ gb: this.gb, dir: this.taskdir, name: this.name });
  this.jobs = null;
  this.task_has_run = false;
  this.fs_events = {};
};

function setLogLevel(new_level) {
  if (new_level !== undefined) {
    log_level = new_level;
    if (log_level === LOG_SILLY) {
      log_timestamp = 'HH:mm:ss.ms';
    } else {
      log_timestamp = 'HH:mm:ss';
    }
  }
}

GlovBuild.prototype.configure = function (opts) {
  assert(opts);
  this.config = merge(this.config, opts);
  // Replace target paths with canonical forward slashes
  for (let key in this.config.targets) {
    this.config.targets[key] = forwardSlashes(this.config.targets[key]);
  }
  this.config.statedir = forwardSlashes(this.config.statedir);
  this.config.source = forwardSlashes(this.config.source);
  this.resetFiles();
  setLogLevel(opts.log_level);
  if (opts.log_timestamp !== undefined) {
    log_timestamp = opts.log_timestamp;
  }
  this.job_queue = asyncLimiter(this.config.parallel.jobs);
};

GlovBuild.prototype.getSourceRoot = function () {
  return this.config.source;
};

GlovBuild.prototype.getDiskPath = function (key) {
  return this.files.getDiskPath(...parseBucket(key));
};

GlovBuild.prototype.resetFiles = function () {
  this.files = filesCreate(this);
  if (this.config.source) {
    this.files.addBucket('source', this.config.source);
  }
  for (let key in this.config.targets) {
    assert(!this.files.getBucketDir(key), `Target "${key}": must not be a reserved name`);
    this.files.addBucket(key, this.config.targets[key]);
  }
  for (let key in this.tasks) { // only upon reset during testing
    let task = this.tasks[key];
    this.files.addBucket(task.name, task.intdir);
  }
};

GlovBuild.prototype.task = function (task) {
  task = new BuildTask(this, task);
  assert(!this.tasks[task.name], `Task "${taskname(task.name)}": task already declared`);
  assert(!this.config.targets[task.name], `Task "${taskname(task.name)}": must not be named the same as a target`);
  assert(!this.files.getBucketDir(task.name), `Task "${taskname(task.name)}": must not be a reserved name`);
  this.files.addBucket(task.name, task.intdir);

  // Validate inter-task dependencies
  // convert dep names to dep references
  // determine the dependency depth ("phase", just for UI?)
  let max_phase = 0;
  for (let ii = 0; ii < task.deps.length; ++ii) {
    let dep_name = task.deps[ii];
    let dep = this.tasks[dep_name];
    assert(dep,
      `Task "${taskname(task.name)}": depends on unknown task "${taskname(dep_name)}"`);
    task.deps[ii] = dep;
    dep.dependors.push(task);
    max_phase = max(max_phase, dep.phase);
  }
  task.phase = max_phase + 1;

  task.deps.sort(cmpTaskPhase);

  this.tasks[task.name] = task;
};

function time(dt) {
  if (dt < 1200) {
    return `${dt}ms`;
  } else if (dt < 12000) {
    return `${(dt/1000).toFixed(1)}s`;
  } else if (dt < 140000) {
    return `${(dt/1000).toFixed(0)}s`;
  } else {
    return `${(dt/60000).toFixed(1)}m`;
  }
}

function taskSetStatus(task, status, message) {
  let now = Date.now();
  let dt = now - task.last_time;
  task.last_time = now;
  if (status !== STATUS_PENDING && task.status !== STATUS_PENDING || status === STATUS_DONE) {
    message = `${time(dt)}${message ? `, ${message}` : ''}`;
  }
  let log_msg = `Task "${taskname(task.name)}": ${task.status}->` +
    `${STATE_COLORED[status]}${message ? ` (${message})` : ''}`;
  if (status === STATUS_PENDING || status === STATUS_PREPARING_INPUTS ||
    status === STATUS_PREPARING_DEPS
  ) {
    ldebug(log_msg);
  } else {
    linfo(log_msg);
  }
  task.status = status;
}

function taskAbort(task) {
  taskSetStatus(task, STATUS_ABORTED);
  if (task.gb.aborting) {
    scheduleTick(task.gb);
  }
}

function taskSetErr(task, err) {
  task.err = err;
  lerror(`Task "${taskname(task.name)}" error:`, err);
  taskSetStatus(task, STATUS_ERROR);
  process.exitCode = 1;
  scheduleTick(task.gb);
}

function BuildJob(gb, task, name, all_files) {
  this.gb = gb;
  this.task = task;
  this.name = name;
  all_files.sort(cmpFile);
  this.files_all = all_files; // All files we depend on
  this.files_base = all_files.slice(0); // Files we intrinsically depend on based on task input
  this.files_updated = all_files.slice(0);
  this.deps_adding = {};
  this.need_sort = true;
  this.on_done = null;
  this.user_data = null;
  this.output_queue = null;
  this.warnings = [];
  this.errors = [];
  this.last_job_state = task.task_state.getJobState(this.name);
  this.job_has_run = false;
  this.dirty = false;
  this.executing = false;
}
BuildJob.prototype.getUserData = function () {
  if (!this.user_data) {
    this.user_data = {};
  }
  return this.user_data;
};
BuildJob.prototype.getTaskUserData = function () {
  assert(this.task.user_data, 'getTaskUserData() only valid if the task has an init/finish hook');
  return this.task.user_data;
};
BuildJob.prototype.debug = function (msg, unexpected) {
  assert(!unexpected);
  assert.equal(typeof msg, 'string');
  ldebug(`  Task "${taskname(this.task.name)}", Job "${this.name}": ${msg}`);
};
BuildJob.prototype.log = function (msg, unexpected) {
  assert(!unexpected);
  assert.equal(typeof msg, 'string');
  linfo(`  Task "${taskname(this.task.name)}", Job "${this.name}": ${msg}`);
};
function jobPrintWarning(job, msg) {
  lwarn(`  Task "${taskname(job.task.name)}", Job "${job.name}": warning:`, msg);
  job.gb.stats.warnings++;
}
// Optional first file argument
BuildJob.prototype.warn = function (file, msg, unexpected) {
  if (isBuildFile(file)) { // shift args
    // TODO: Include file name automatically?
    this.error_files[file.key] = true;
  } else {
    unexpected = msg;
    msg = file;
    file = null;
  }
  assert(!unexpected);
  assert.equal(typeof msg, 'string');
  this.warnings.push(msg);
  jobPrintWarning(this, msg);
};
function jobPrintError(job, err) {
  let ret;
  if (err instanceof Error && err.stack) {
    let stack = err.stack;
    stack = stack.split('\n');
    for (let ii = 0; ii < stack.length; ++ii) {
      if (stack[ii].indexOf('glovBuildRunJobFunc') !== -1) {
        stack = stack.slice(0, ii);
      }
    }
    ret = stack[0];
    lerror(`  Task "${taskname(job.task.name)}", Job "${job.name}": error:`,
      stack.join('\n  '));
  } else {
    err = String(err);
    ret = err;
    lerror(`  Task "${taskname(job.task.name)}", Job "${job.name}": error:`,
      err);
  }
  job.gb.stats.errors++;
  return ret;
}
BuildJob.prototype.error = function (file, err, unexpected) {
  if (isBuildFile(file)) {
    // TODO: Include file name automatically?
    this.error_files[file.key] = true;
    assert(err, 'job.error passed a BuildFile but no error!');
  } else { // shift args
    unexpected = err;
    err = file;
    file = null;
  }
  assert(!unexpected);
  if (!err) {
    return;
  }
  let msg = jobPrintError(this, err);
  this.errors.push(msg);
};
BuildJob.prototype.getTaskType = function () {
  return this.task.type;
};

function taskOutputFsEvent(task, event, key) {
  for (let ii = 0; ii < task.dependors_active.length; ++ii) {
    let next_task = task.dependors_active[ii];
    // If we're making changes, those that depend on us must be reset to pending already
    // TODO: What if they're still running from a previous update?
    assert(next_task.status === STATUS_PENDING || next_task.status === STATUS_ABORTED);
    next_task.fs_events[key] = event;
  }
}

// errors added to job.errors
function jobOutputFiles(job, cb) {
  // updates file.timestamp in BuildFiles
  let who = `${job.task.name}:${job.name}`;
  let count = 0;
  let to_prune = {};
  let last_outputs = job.last_job_state && job.last_job_state.outputs || {};
  for (let key in last_outputs) {
    to_prune[key] = true;
  }
  asyncEach(Object.values(job.output_queue), function (file, next) {
    ++count;
    let buildkey = `${job.task.bucket_out}:${file.relative}`;
    delete to_prune[buildkey];

    assert(Buffer.isBuffer(file.contents));
    let file_data = {
      bucket: job.task.bucket_out,
      relative: file.relative,
      contents: file.contents,
      who,
    };
    let crc = crc32(file.contents);
    let last_data = last_outputs[buildkey];
    if (last_data && last_data.crc === crc) {
      // unchanged, do not write to disk, do not invalidate later tasks
      job.gb.debug(`  Output ${buildkey} unchanged, not updating`);
      // Still need to let Files know it exists though, may not have been loaded this session
      file_data.skip_write = true;
      file_data.timestamp = last_data.ts;
    } else {
      let notify_key = `${job.task.name}:${file.relative}`;
      taskOutputFsEvent(job.task, 'add', notify_key);
    }
    job.gb.files.put(file_data, function (err, buildfile) {
      if (err) {
        job.error(err);
      } else {
        assert(buildfile.timestamp);
        job.job_state.outputs[buildfile.key] = { ts: buildfile.timestamp, crc };
      }
      next();
    });
  }, function () {
    // TODO: Maybe don't prune missing outputs upon error - need to keep them in
    //   the job state for pruning later, though!
    let prune_count = 0;
    asyncEach(Object.keys(to_prune), function (key, next) {
      ++prune_count;
      taskOutputFsEvent(job.task, 'unlink', key);
      job.gb.files.prune(...parseBucket(key), next);
    }, function () {
      job.output_queue = null;
      cb(count, prune_count);
    });
  });
}
BuildJob.prototype.jobDone = function (next) {
  assert(this.job_state !== this.last_job_state); // no longer gets here if nothing changed?
  // Writing all output files after all user code has run for this job
  jobOutputFiles(this, (num_files, num_pruned) => {
    let any_errors = false;
    if (this.errors.length) {
      any_errors = true;
      this.job_state.errors = this.errors;
    } else {
      delete this.job_state.errors;
    }
    if (this.warnings.length) {
      any_errors = true;
      this.job_state.warnings = this.warnings;
    } else {
      delete this.job_state.warnings;
    }
    this.job_state.version = this.task.version;
    // Do we want to keep everything as "updated" until errors go away? No,
    // we just print out the previous errors for SINGLE jobs, and ALL jobs
    // handle it themselves facilitated by the fact that we keep any files
    // that were specifically passed to .warn or .error as dirty.
    if (!any_errors) {
      this.files_updated.length = 0;
    } else {
      this.files_updated = this.files_updated.filter((file) => this.error_files[file.key]);
    }
    // Flush job state immediately after writing all files
    // Might be slightly delayed when all jobs state are in the same file, though
    this.last_job_state = this.job_state;
    this.task.task_state.setJobState(this.name, this.job_state, (err) => {
      if (err) {
        lerror(`Internal error writing job state for ${this.task.name}:${this.name}`, err);
      }
      if (this.errors.length) {
        linfo(`  Task "${taskname(this.task.name)}", Job "${this.name}": failed`);
      } else {
        let num_deps = Object.keys(this.job_state.deps).length;
        this.task.count_outputs += num_files;
        this.task.count_deps += num_deps;
        (this.warnings.length ? linfo : ldebug)(`  Task "${taskname(this.task.name)}", Job "${this.name}": complete (` +
          `${plural(num_deps, 'dep')}` +
          `, ${plural(num_files, 'output')}` +
          `${this.warnings.length ? `, ${plural(this.warnings.length, 'warning')}` : ''}` +
          `${num_pruned ? `, ${num_pruned} pruned` : ''}` +
          ')');
      }
      next(err);
    });
  });
};
function cmpFile(a, b) {
  assert(a.bucket !== b.bucket || a.relative !== b.relative);
  if (a.bucket < b.bucket || a.bucket === b.bucket && a.relative < b.relative) {
    return -1;
  }
  return 1;
}
BuildJob.prototype.sort = function () {
  if (!this.need_sort) {
    return;
  }
  this.need_sort = false;
  // TODO: if task.type=ALL and task.input is more than
  //   one entry, for each file search the input globs to see which it came from
  //   and then sort by that, so input lists implicitly cause sort?
  this.files_all.sort(cmpFile);
  this.files_updated.sort(cmpFile);
};
BuildJob.prototype.getFile = function () {
  assert.equal(this.task.type, SINGLE);
  assert.equal(this.files_base.length, 1);
  return this.files_base[0];
};
BuildJob.prototype.getFiles = function () {
  this.sort();
  return this.files_all;
};
BuildJob.prototype.getFilesUpdated = function () {
  this.sort();
  this.gb.stats.files_updated += this.files_updated.length;
  return this.files_updated;
};
BuildJob.prototype.isFileBase = function (file) {
  return this.files_base.indexOf(file) !== -1;
};
BuildJob.prototype.isFileUpdated = function (file) {
  // PERFTODO: lazy-build lookup table?
  return this.files_updated.indexOf(file) !== -1;
};
BuildJob.prototype.out = function (file) {
  // flush all files simultaneously at end of job, and immediately before flushing job state
  this.output_queue = this.output_queue || {};
  let key = file.relative; // bucket ignored, that's probably the source! `${file.bucket}:${file.relative}`;
  assert(key.indexOf('\\') === -1, // Maybe auto-fix?
    `job.out() called with non-normalized path "${file.relative}" (contains back slashes)`);
  assert(key.indexOf('../') === -1,
    `job.out() called with potentially escaping relative path "${file.relative}" (contains ../)`);
  if (typeof file.contents === 'string') {
    file.contents = Buffer.from(file.contents);
  }
  assert(Buffer.isBuffer(file.contents),
    `job.out() called with non-string/non-Buffer contents (${file.contents ? typeof file.contents : file.contents})`);

  if (this.output_queue[key]) {
    this.err = this.err || new Error(`Job is outputting the same file ("${key}") twice`);
  } else {
    this.output_queue[key] = file;
  }
};

BuildJob.prototype.depReset = function () {
  let expected_deps = {};
  for (let ii = 0; ii < this.files_base.length; ++ii) {
    expected_deps[this.files_base[ii].key] = 1;
  }
  for (let key in this.job_state.deps) {
    if (!expected_deps[key]) {
      // This should only happen during run-time re-run of job that's ran in the
      //  same process
      assert(this.job_has_run);
      delete this.job_state.deps[key];
      // also prune from files_updated and files_all!
      jobFileListRemove(this, 'files_all', key);
      jobFileListRemove(this, 'files_updated', key);
    }
  }
};

// Returns any error if not up to date
BuildJob.prototype.isUpToDate = function (cb) {
  if (!this.last_job_state) {
    return cb('no previous state');
  }
  let { gb, task, last_job_state, files_updated } = this;
  let { deps, outputs, warnings, errors, version } = last_job_state;
  if (task.version !== (version || 0)) {
    linfo(`  Task "${taskname(this.task.name)}", Job "${this.name}": ` +
      `New task version (current: ${task.version}, previous: ${version||0})`);
    return cb('mismatched task version');
  }
  // check that all current inputs are in the previous deps
  for (let ii = 0; ii < files_updated.length; ++ii) {
    let file = files_updated[ii];
    if (!deps[file.key]) {
      linfo(`  Task "${taskname(this.task.name)}", Job "${this.name}": "${file.key}"` +
        ' not in previous inputs, updating...');
      return cb('new input');
    }
    // timestamp equality will be checked below
  }
  // TODO: We actually (kind of) want the early-out behavior of `async.each` here,
  //   in that as soon as we know we need to update something, we don't need to
  //   keep checking the other deps.  However, this produces inconsistent test
  //   cases (change these to be `eachSeries`?), and we *do* want the behavior
  //   that the final callback is not called until all (running) tasks are done,
  //   lest we get log messages showing up after it's already started the job
  //   executing.
  asyncEach([['dep', deps], ['output', outputs]], (pair, next) => {
    let [coll_key, coll] = pair;
    asyncEachLimit(Object.keys(coll), ASYNC_LIMIT, (key, next) => {
      let dep_timestamp = coll[key];
      if (dep_timestamp && dep_timestamp.ts) { // outputs[]
        dep_timestamp = dep_timestamp.ts;
      }
      gb.files.getStat(...parseBucket(key), `${this.task.name}:${this.name}`, (err, file) => {
        if (err) {
          if (coll === deps && dep_timestamp === DELETED_TIMESTAMP) {
            // This file is missing, but it was already missing, possibly an optional dependency of a smart task
            // Do NOT forcibly re-run the task, nothing has changed.
          } else {
            linfo(`  Task "${taskname(this.task.name)}", Job "${this.name}": "${key}" ` +
              `(${coll_key}) missing or errored, updating...`);
            // invalidate the job state so any outputted file will be saved to disk
            //   even if it is the same as a previous (missing) file
            coll[key] = null;
            return next(err);
          }
        }
        if (file.timestamp !== dep_timestamp) {
          if (coll[key] && coll[key].crc) { // outputs[]
            // Clear cached CRC - if this job outputs the same as the previous run, we still have to write it!
            coll[key].crc = null;
          }
          ldebug(`  Task "${taskname(this.task.name)}", Job "${this.name}": "${key}" ` +
            `(${coll_key}) changed, updating...`);
          return next('timestamp');
        }
        next();
      });
    }, next);
  }, (err) => {
    if (!err) {
      // This could be checked earlier, but the log message doesn't make sense
      //   when we're dynamically re-running this due to a source file change.
      if (warnings || errors) {
        linfo(`  Task "${taskname(this.task.name)}", Job "${this.name}": ` +
          `Previous run ${errors ? 'errored' : 'warned'}, re-running...`);
        return cb('previous run warned or errored');
      }
      // do not change job state
      this.job_state = this.last_job_state;
    }
    cb(err);
  });
};

function parseBucket(filename) {
  assert(filename);
  let split = filename.split(':');
  assert(split.length <= 2);
  if (split.length === 2) {
    return split;
  } else {
    return ['source', filename];
  }
}

function taskDependsOnTask(task, other_name) {
  for (let ii = 0; ii < task.deps.length; ++ii) {
    if (task.deps[ii].name === other_name) {
      return true;
    }
  }
  return false;
}

BuildJob.prototype.depAdd = function (name, cb) {
  assert(this.executing, 'job.depAdd() called on job that is no longer executing!');
  name = forwardSlashes(name);
  let [bucket, relative] = parseBucket(name);
  if (bucket !== 'source') {
    // must reference a dependency of this task
    if (this.gb.config.targets[bucket]) {
      // references a target, just hope the user is not doing something invalid here!
    } else {
      assert(this.gb.tasks[bucket],
        `Job "${this.name}" in Task "${taskname(this.task.name)}" references output from "${bucket}"` +
        ' which is not a declared task or target');
      assert(taskDependsOnTask(this.task, bucket),
        `Job "${this.name}" in Task "${taskname(this.task.name)}" references output from "${bucket}"` +
        ' which is not an explicit dependency');
    }
  }

  let key = `${bucket}:${relative}`;
  if (this.deps_adding[key]) {
    this.deps_adding[key].push(cb);
    return;
  }

  // already a dep? PERFTODO: something faster?
  for (let ii = 0; ii < this.files_all.length; ++ii) {
    let file = this.files_all[ii];
    if (file.bucket === bucket && file.relative === relative) {
      return cb(file.err, file);
    }
  }

  let adding = this.deps_adding[key] = [cb];
  this.gb.files.get(bucket, relative, (err, file) => {
    assert(this.files_all.indexOf(file) === -1);
    this.files_all.push(file);
    this.files_updated.push(file);
    this.need_sort = true;
    assert.equal(file.err, err);
    this.job_state.deps[file.key] = file.timestamp; // will be -1 if `err`
    assert.equal(this.deps_adding[key], adding);
    delete this.deps_adding[key];
    for (let ii = 0; ii < adding.length; ++ii) {
      adding[ii](file.err, file);
    }
  });
};

function delayRun(gb, key, fn, ...args) {
  if (gb.delays[key]) {
    setTimeout(fn.bind(null, ...args), gb.delays[key]);
  } else {
    fn(...args);
  }
}

function startTask(gb, task) {
  assert.equal(task.status, STATUS_PENDING);
  if (!task.input) {
    assert(!task.func);
    taskSetStatus(task, STATUS_DONE);
    return scheduleTick(gb);
  }
  taskSetStatus(task, STATUS_PREPARING_INPUTS);
  ++gb.stats.phase_inputs;

  delayRun(gb, 'inputs_pre', function () {
    task.task_state.loadAll(taskGatherInputs.bind(null, gb, task));
  });
}

function taskGatherInputs(gb, task) {
  assert.equal(task.status, STATUS_PREPARING_INPUTS);
  if (gb.aborting) {
    return taskAbort(task);
  }
  if (task.task_has_run) {
    taskGatherInputsDynamic(gb, task);
  } else {
    task.task_has_run = true;
    taskGatherInputsFirstRun(gb, task);
  }
}

function mapValuesSeries(obj, iteratee, callback) {
  let ret = {};
  asyncEachSeries(Object.keys(obj), function (key, next) {
    iteratee(obj[key], key, function (err, res) {
      ret[key] = res;
      next(err);
    });
  }, function (err) {
    callback(err, ret);
  });
}

function getIndex(value, idx) {
  return idx;
}
function mapArrayLimit(arr, limit, iteratee, callback) {
  let ret = new Array(arr.length);
  asyncEachLimit(arr.map(getIndex), limit, function (idx, next) {
    iteratee(arr[idx], function (err, res) {
      ret[idx] = res;
      next(err);
    });
  }, function (err) {
    callback(err, ret);
  });
}

function taskGatherInputsFirstRun(gb, task) {
  assert.equal(task.status, STATUS_PREPARING_INPUTS);
  task.fs_events = {};
  // gather inputs (just names and stat of files)
  mapValuesSeries(task.globs_by_bucket, function (globs, bucket, next) {
    if (bucket === 'source') {
      // Raw from filesystem
      fg(globs, {
        cwd: gb.files.getBucketDir(bucket),
        objectMode: true,
      }, function (err, entries) {
        if (err) {
          return next(err);
        }
        mapArrayLimit(entries, ASYNC_LIMIT, function (file, next) {
          gb.files.getStat(bucket, file.path, task.name, function (err, buildfile) {
            if (err) {
              return next(err);
            }
            return next(null, buildfile);
          });
        }, function (err, mapped) {
          if (err) {
            return next(err);
          }
          next(null, mapped);
        });
      });
    } else {
      // intermediate bucket, use in-memory information
      // This will have the outputs from a previous run because each task has
      //   don a getStat on all of its outputs by now, I think?
      let source_task = gb.tasks[bucket];
      if (source_task.target) {
        // the specific task outputs to a target, cannot just glob all the files
        // in the target - use the outputs in the task state
        let job_states = source_task.task_state.getAllJobStates();
        let inputs = [];
        asyncEachSeries(Object.values(job_states), function (job_state, next) {
          let { outputs } = job_state;
          if (!outputs) {
            return next();
          }
          let files = [];
          for (let key in outputs) {
            let relative = key.split(':')[1];
            if (micromatch(relative, globs).length) {
              files.push(relative);
            }
          }
          asyncEachSeries(files, function (relative, next) {
            gb.files.getStat(source_task.target, relative, task.name, function (err, buildfile) {
              if (buildfile) {
                inputs.push(buildfile);
              }
              next(err);
            });
          }, next);
        }, function (err) {
          next(err, inputs);
        });
      } else {
        // Glob a whole bucket
        let mapped = gb.files.glob(bucket, globs);
        next(null, Object.values(mapped));
      }
    }
  }, function (err, files_by_bucket) {
    if (err) {
      return taskSetErr(task, err);
    }
    let files = [];
    for (let key in files_by_bucket) {
      files = files.concat(files_by_bucket[key]);
    }
    taskPrepJobsFirstRun(gb, task, files);
  });
}

function taskPrepJobsFirstRun(gb, task, input_files) {
  assert.equal(task.status, STATUS_PREPARING_INPUTS);
  // Not safe to abort here, we need to finish processing the on-disk files we scanned!

  // Create BuildJobs for those that currently exist
  //   files_all = files_updated = base files
  // Prune outputs from disk and state for jobs that don't exist anymore
  // Stat all of the dependencies
  // Determine which jobs need to be executed
  //   Any whose inputs changed
  //   Any whose version changed / previously warned / previously errored / weren't there before

  let job_states = task.task_state.getAllJobStates();
  let waiting = 1;
  function done() {
    --waiting;
    if (!waiting) {
      delayRun(gb, 'inputs_post', taskPrepDeps.bind(null, gb, task));
    }
  }
  function pruneFile(filename) {
    ++waiting;
    taskOutputFsEvent(task, 'unlink', filename);
    gb.files.prune(...parseBucket(filename), done);
  }

  assert(!task.jobs);
  let jobs = task.jobs = {};
  let expected = {};

  if (task.type === SINGLE) {
    // make a job for each input
    for (let ii = 0; ii < input_files.length; ++ii) {
      let the_file = input_files[ii];
      let key = the_file.key;
      expected[key] = true;
      let job = new BuildJob(gb, task, key, [the_file]);
      jobs[key] = job;
    }
  } else if (task.type === ALL) {
    // make a single job
    expected.all = true;
    jobs.all = new BuildJob(gb, task, 'all', input_files);
  }

  for (let job_name in job_states) {
    let job_state = job_states[job_name];
    if (!expected[job_name]) {
      // Prune jobs that are no longer valid
      linfo(`  Task "${taskname(task.name)}", Job "${job_name}": not in new input, pruning...`);
      ++waiting;
      task.task_state.setJobState(job_name, null, done);
      for (let key in job_state.outputs) {
        pruneFile(key);
      }
    } else {
      // Register outputs for valid jobs, so conflicting output detection can catch them
      let who =`${task.name}:${job_name}`;
      for (let key in job_state.outputs) {
        task.gb.files.getPre(...parseBucket(key)).who = who;
      }
    }
  }

  asyncEachLimit(Object.values(jobs), 1, function (job, next) {
    job.isUpToDate(function (err) {
      if (err) {
        // needs updating
        job.dirty = true;
      } else {
        lsilly(`  Task "${taskname(task.name)}", Job "${job.name}": up to date`);
      }
      next();
    });
  }, done);
}

function jobFileListFind(job, list_name, key) {
  let list = job[list_name];
  for (let jj = 0; jj < list.length; ++jj) {
    let buildfile = list[jj];
    if (buildfile.key === key) {
      return jj;
    }
  }
  return -1;
}

function jobFileListRemove(job, list_name, key) {
  let idx = jobFileListFind(job, list_name, key);
  if (idx !== -1) {
    let list = job[list_name];
    let buildfile = list[idx];
    ridx(list, idx);
    job.need_sort = true;
    return buildfile;
  }
  return null;
}

function jobFileListUpdate(job, list_name, file, required) {
  let idx = jobFileListFind(job, list_name, file.key);
  if (idx !== -1) {
    job[list_name][idx] = file;
    job.dirty = true;
    return true;
  }
  console.log(job[list_name]);
  assert(!required);
  return false;
}

function jobFileListAdd(job, list_name, file) {
  let list = job[list_name];
  job.dirty = true;
  let idx = jobFileListFind(job, list_name, file.key);
  if (idx !== -1) {
    list[idx] = file;
    return false;
  }
  list.push(file);
  job.need_sort = true;
  return true;
}

function taskGatherInputsDynamic(gb, task) {
  assert.equal(task.status, STATUS_PREPARING_INPUTS);
  let { fs_events, jobs, globs_by_bucket } = task;
  task.fs_events = {};
  let waiting = 1;
  function done() {
    --waiting;
    if (!waiting) {
      delayRun(gb, 'inputs_post', taskPrepDeps, gb, task);
    }
  }
  function pruneFile(filename) {
    ++waiting;
    taskOutputFsEvent(task, 'unlink', filename);
    gb.files.prune(...parseBucket(filename), done);
  }
  // Dirty appropriate jobs based on fs_events
  // Deleted file:
  //   Prune outputs from disk and state for jobs that don't exist anymore
  //   Find jobs that depended on this file (either gb.ALL or an external dep, not a base SINGLE)
  //     ALL and base file:
  //       Remove from files_all, potentially add to files_updated
  //     any external dep:
  //       Leave in files_all, potentially add to files_updated
  //     Flag job as needing to be executed
  // Added file:
  //   Can affect task base inputs as well as external deps for any task that tried
  //     to reference this file previously and it did not exist
  //   SINGLE:
  //     Create new BuildJob, flag it as needing to be executed
  //   ALL:
  //     Add to files_all/files_updated, flag it as needing to be executed
  //   external deps:
  //     if has run in this process already: add to files_updated
  //     if has not run, just need to flag as needing to be executed it will be receiving only the base file anyway
  // Changed file:
  //   Find all jobs by base or external, put into files_updated, flag as needing to be executed
  for (let key in fs_events) {
    let event = fs_events[key];
    let [bucket, relative] = parseBucket(key);
    let disk_bucket = bucket;
    if (gb.tasks[bucket] && gb.tasks[bucket].target) {
      disk_bucket = gb.tasks[bucket].target;
      key = `${disk_bucket}:${relative}`;
    }
    let the_file = gb.files.getPre(disk_bucket, relative);
    if (event === 'unlink') {
      // Deleted file:
      if (task.type === gb.SINGLE) {
        // Prune outputs from disk and state for jobs that don't exist anymore
        let job = jobs[key];
        if (job) {
          linfo(`  Task "${taskname(task.name)}", Job "${job.name}": input deleted, pruning...`);
          let job_state = job.last_job_state;
          if (job_state) {
            ++waiting;
            task.task_state.setJobState(job.name, null, done);
            for (let output_key in job_state.outputs) {
              pruneFile(output_key);
            }
            task.had_pruned_job = true;
          }
          delete jobs[key];
        }
      }
      //   Find jobs that depended on this file (either gb.ALL or an external dep, not a base SINGLE)
      //     ALL and base file:
      //       Remove from files_all, potentially add to files_updated
      //     any external dep:
      //       Leave in files_all, potentially add to files_updated
      //     Flag job as needing to be executed
      for (let job_name in jobs) {
        let job = jobs[job_name];
        let job_state = job.last_job_state;
        if (job_state && job_state.deps[key]) {
          linfo(chalk.black.bold(`  Task "${taskname(task.name)}", Job "${job.name}": dep deleted: ${key}`));
          if (job.job_has_run) {
            let removed = jobFileListRemove(job, 'files_base', key);
            if (removed) {
              job.dirty = true;
              assert.equal(task.type, gb.ALL);
              jobFileListRemove(job, 'files_all', key);
              jobFileListAdd(job, 'files_updated', the_file);
            } else {
              // not a base file, must be external dep, or a base file we didn't know about?
              jobFileListUpdate(job, 'files_all', the_file, true);
              // in files_all and deps, but not files_base, must be an external dep
              job.dirty = true;
              jobFileListAdd(job, 'files_updated', the_file);
            }
          } else {
            // Has not run, should never know about this file when it first runs, just remove and flag as dirty
            jobFileListRemove(job, 'files_base', key);
            jobFileListRemove(job, 'files_all', key);
            jobFileListRemove(job, 'files_updated', key);
            job.dirty = true;
          }
        }
      }
    } else if (event === 'add' || event === 'change') {
      // Changed or Added file:
      //   Can affect task base inputs as well as external deps for any task that tried
      //     to reference this file previously and it did not exist

      let logged = false;
      let globs = globs_by_bucket[bucket];
      if (globs) {
        if (micromatch(relative, globs).length) {
          if (task.type === gb.SINGLE) {
            //   SINGLE and matches input glob:
            //     If needed, create new BuildJob, else add to files_updated
            //     flag it as needing to be executed
            // added or changed a base file that needs to be mapped to a job
            let job = jobs[key];
            if (!job) {
              job = jobs[key] = new BuildJob(gb, task, key, [the_file]);
              job.dirty = true;
              ldebug(`  Task "${taskname(task.name)}", Job "${job.name}": new job from new input`);
              logged = true;
            } else {
              // This will happen in deps checking below anyway, but let's assert the state is as we expect
              jobFileListUpdate(job, 'files_base', the_file, true);
              jobFileListUpdate(job, 'files_all', the_file, true);
              jobFileListAdd(job, 'files_updated', the_file);
              ldebug(`  Task "${taskname(task.name)}", Job "${job.name}": base file modified`);
              logged = true;
            }
          } else if (task.type === gb.ALL) {
            //   ALL and matches input glob:
            //     If needed, Add to files_all/files_updated
            // added or changed a base file
            let job = jobs.all;
            let is_new = jobFileListAdd(job, 'files_base', the_file);
            jobFileListAdd(job, 'files_all', the_file);
            jobFileListAdd(job, 'files_updated', the_file);
            if (is_new) {
              ldebug(`  Task "${taskname(task.name)}", Job "${job.name}": new input: ${key}`);
              logged = true;
            } else {
              ldebug(`  Task "${taskname(task.name)}", Job "${job.name}": input modified: ${key}`);
              logged = true;
            }
          }
        }
      }
      //   external deps:
      //     if has run in this process already: add to files_updated
      //     if has not run, just need to flag as needing to be executed it will be receiving only the base file anyway
      for (let job_name in jobs) {
        let job = jobs[job_name];
        let job_state = job.last_job_state;
        if (job_state && job_state.deps[key]) {
          if (job.job_has_run) {
            jobFileListUpdate(job, 'files_all', the_file, true);
            jobFileListAdd(job, 'files_updated', the_file);
            if (!logged) {
              ldebug(`  Task "${taskname(task.name)}", Job "${job.name}": dep modified: ${key}`);
            }
          } else {
            if (!logged) {
              ldebug(`  Task "${taskname(task.name)}", Job "${job.name}":` +
                ` un-run job dirtied from change to dep ${key}`);
            }
            // has not run, job.files_all is currently == job.files_base, we don't
            //   actually want to add anything to it, just flag it as dirty
            job.dirty = true;
          }
        }
      }
    } else {
      assert(false, `Unexpected fs_event ${event}`);
    }
  }

  done();
}

function taskInit(task, next) {
  if (task.did_init) {
    return next();
  }
  if (task.post_init) {
    task.post_init.push(next);
    return;
  }
  task.user_data = {};
  if (!task.init) {
    task.did_init = true;
    return next();
  }
  task.post_init = [next];
  let start = Date.now();
  if (!task.ever_did_init) {
    linfo(`  Task "${taskname(task.name)}": initializing...`);
  }
  task.init(function () {
    let dt = Date.now() - start;
    if (!task.ever_did_init || dt > 750) {
      linfo(`  Task "${taskname(task.name)}": initialized in ${time(dt)}`);
    }
    task.ever_did_init = true;
    task.did_init = true;
    for (let ii = 0; ii < task.post_init.length; ++ii) {
      task.post_init[ii]();
    }
    task.post_init = null;
  });
}

function isDirty(job) {
  return job.dirty;
}

function getUpdatedFiles(job) {
  return job.files_updated;
}

function taskPrepDeps(gb, task) {
  // Pre-load all files, so the data is ready synchronously for task functions,
  // and so that we can potentially interrupt this task between the slow, often
  // interrupted loading and job execution.
  assert.equal(task.status, STATUS_PREPARING_INPUTS);

  if (gb.aborting) {
    return taskAbort(task);
  }

  let { jobs } = task;

  if (task.had_pruned_job) {
    task.had_pruned_job = false;
    // Re-run existing jobs that errored
    // Only definitely need this if we just pruned a job that was generating
    // an output conflict error - any errors from inputs should trigger dirtiness
    // from their dependency tracking.
    for (let key in jobs) {
      let job = jobs[key];
      if (!job.dirty && job.errors && job.errors.length) {
        job.dirty = true;
        linfo(`  Task "${taskname(task.name)}", Job "${job.name}": ` +
          `Previous run ${job.errors && job.errors.length ? 'errored' : 'warned'}, re-running...`);
      }
    }
  }

  let dirty_jobs = Object.values(jobs).filter(isDirty);
  let files = [].concat(...dirty_jobs.map(getUpdatedFiles));
  ++gb.stats.phase_deps;
  if (!task.read) {
    files = [];
  }
  taskSetStatus(task, STATUS_PREPARING_DEPS,
    `${dirty_jobs.length}/${Object.keys(jobs).length} jobs, ${files.length} files`);
  asyncEachLimit(files, ASYNC_LIMIT, function (file, next) {
    file.get(function (ignored) {
      next();
    });
  }, function (err) {
    assert(!err, err);
    delayRun(gb, 'deps', executeTask, gb, task, dirty_jobs);
  });
}

function executeTask(gb, task, dirty_jobs) {
  assert.equal(task.status, STATUS_PREPARING_DEPS);

  if (gb.aborting) {
    return taskAbort(task);
  }

  let { jobs } = task;
  taskSetStatus(task, STATUS_RUNNING, `${dirty_jobs.length}/${Object.keys(jobs).length} jobs`);
  ++gb.stats.phase_run;

  task.did_init = !(task.init || task.finish);
  task.post_init = null;
  let error_count = 0;
  // Reset counters for run-time stats
  task.count_outputs = 0;
  task.count_deps = 0;
  task.last_run_time = Date.now();
  asyncEachLimit(dirty_jobs, ASYNC_LIMIT, function (job, next) {
    gb.job_queue(function (next) {
      if (gb.aborting) {
        return next();
      }
      executeJob(gb, task, job, function (err) {
        error_count += job.errors.length;
        next(err);
      });
    }, next);
  }, function (err) {
    if (task.finish && task.did_init) {
      task.finish();
    }
    // Re-output any warnings/errors from jobs that were not dirty, but have
    //  warnings/errors
    let dirty_keys = {};
    for (let ii = 0; ii < dirty_jobs.length; ++ii) {
      dirty_keys[dirty_jobs[ii].name] = true;
    }
    for (let job_name in jobs) {
      if (dirty_keys[job_name]) {
        continue;
      }
      let job = jobs[job_name];
      for (let jj = 0; jj < job.warnings.length; ++jj) {
        jobPrintWarning(job, job.warnings[jj]);
      }
      for (let jj = 0; jj < job.errors.length; ++jj) {
        ++error_count;
        jobPrintError(job, job.errors[jj]);
      }
    }

    if (!err && error_count) {
      err = plural(error_count, 'error');
    }
    if (err) {
      return taskSetErr(task, err);
    }
    taskSetStatus(task, gb.aborting ? STATUS_ABORTED : STATUS_DONE, plural(task.count_outputs, 'output'));
    scheduleTick(gb);
  });
}

function executeJob(gb, task, job, next) {
  assert(job.dirty);
  if (!job.job_has_run) {
    // Fresh state should always be: and files_all == files_base == files_updated, and no deleted files
    assert.equal(job.files_updated.length, job.files_all.length);
    assert.equal(job.files_updated.length, job.files_base.length);
    for (let ii = 0; ii < job.files_updated.length; ++ii) {
      assert.equal(job.files_updated[ii], job.files_all[ii]);
      assert.equal(job.files_updated[ii], job.files_base[ii]);

      assert(!task.read ||
        job.files_updated[ii].contents ||
        job.files_updated[ii].err && job.files_updated[ii].err !== 'ERR_DOES_NOT_EXIST');
    }
  }

  // TODO: move this into a job.reset() or something?
  let deps = {}; // filename (bucket:relative) => timestamp
  for (let ii = 0; ii < job.files_all.length; ++ii) {
    let buildfile = job.files_all[ii];
    deps[buildfile.key] = buildfile.timestamp;
  }
  job.job_state = {
    deps,
    outputs: {},
  };
  job.output_queue = {};
  job.warnings = [];
  job.errors = [];
  job.error_files = {};
  taskInit(task, function () {
    let start_time = Date.now();
    for (let ii = 0; ii < job.files_updated.length; ++ii) {
      let file = job.files_updated[ii];
      assert(!task.read || file.err || file.contents); // should already be loaded
    }
    job.dirty = false;
    gb.stats.jobs++;
    let is_done = false;
    job.executing = true;
    function done(err) {
      job.executing = false;
      assert(!is_done, `done() called twice for Task "${taskname(task.name)}", job "${job.name}"`);
      is_done = true;
      job.job_has_run = true;
      job.execution_time = Date.now() - start_time;
      job.error(err);
      job.jobDone(next);
    }
    // Check base files for OS error
    let base_error = false;
    for (let ii = 0; ii < job.files_base.length; ++ii) {
      let file = job.files_base[ii];
      if (file.err) {
        job.error(file.err);
        base_error = true;
      }
    }
    if (base_error) {
      done();
    } else {
      task.func(job, done);
    }
  });
}

// Returns true if entirely spurious
function reoutputErrors(gb) {
  let { last_finish_time, tasks } = gb;
  assert(last_finish_time);
  // Did any task run?
  let any_ran = false;
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (task.last_run_time >= last_finish_time) {
      any_ran = true;
      break;
    }
  }
  if (!any_ran) {
    // was spurious, ignore
    return true;
  }
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (!task.active || task.last_run_time >= last_finish_time) {
      continue;
    }
    let { jobs } = task;
    for (let job_name in jobs) {
      let job = jobs[job_name];
      for (let jj = 0; jj < job.warnings.length; ++jj) {
        jobPrintWarning(job, job.warnings[jj]);
      }
      for (let jj = 0; jj < job.errors.length; ++jj) {
        jobPrintError(job, job.errors[jj]);
      }
    }
  }
  return false;
}

function idleCheck(gb) {
  gb.idle_timeout = null;
  let { tasks } = gb;
  let candidate;
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (task.init && !task.did_init) {
      candidate = task;
      break;
    }
  }
  if (!candidate) {
    if (!gb.did_idle_done_msg) {
      gb.did_idle_done_msg = true;
      gb.info(chalk.green('All tasks initialized, continuing waiting for changes...'));
    }
    return;
  }
  let task = candidate;
  gb.debug(`In watching state, idle, initializing task "${taskname(task.name)}"`);
  gb.idle_init_in_progress = true;
  taskInit(task, function () {
    gb.idle_init_in_progress = false;
    assert(!gb.idle_timeout);
    if (!gb.start_time) {
      gb.idle_timeout = setTimeout(idleCheck.bind(null, gb), TIME_BEFORE_IDLE_INIT);
    }
  });
}

function tick(gb) {
  gb.tick_scheduled = false;
  let { tasks, aborting, was_all_done } = gb;
  let all_tasks_done = true;
  let any_change = false;
  let any_errored = false;
  let avail_tasks = gb.config.parallel.tasks;
  let executing_tasks = 0;
  // Count executing tasks and gather status
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (!task.active) {
      continue;
    }
    if (task.status === STATUS_ERROR || task.status === STATUS_ABORTED) {
      any_errored = true;
    } else if (task.status !== STATUS_DONE) {
      all_tasks_done = false;
      if (task.status !== STATUS_PENDING) {
        executing_tasks++;
      }
    }
  }

  // Start or abort pending tasks whose deps are all done
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (!task.active) {
      continue;
    }
    if (task.status !== STATUS_PENDING) {
      continue;
    }
    let all_deps_done = true;
    let dep_errored = false;
    for (let ii = 0; ii < task.deps.length; ++ii) {
      let dep = task.deps[ii];
      if (dep.status === STATUS_ERROR || dep.status === STATUS_ABORTED) {
        dep_errored = true;
      } else if (dep.status !== STATUS_DONE) {
        all_deps_done = false;
      }
    }
    if (!all_deps_done) {
      continue;
    }
    if (dep_errored || aborting) {
      taskSetStatus(task, STATUS_ABORTED);
      any_change = true;
      continue;
    }
    if (executing_tasks >= avail_tasks) {
      continue;
    }
    ++executing_tasks;
    startTask(gb, task);
  }
  gb.was_all_done = all_tasks_done;
  if (all_tasks_done) {
    if (aborting) {
      finishAbort(gb);
      any_change = true;
    } else if (!was_all_done) {
      let err_msg = any_errored ? 'At least one task has errored' : undefined;
      if (gb.watcher) {
        // Re-output any errors from tasks that did run since we last reset last_finish_time
        let entirely_spurious = reoutputErrors(gb);

        let now = Date.now();
        gb.last_finish_time = now;
        let dt = Date.now() - gb.start_time;
        // TODO: Also detect if any had outstanding warnings
        if (entirely_spurious) {
          if (err_msg) {
            err_msg = 'At least one errored task, but tick cycle was spurious';
          }
          gb.debug('Only spurious changes detected, going back to waiting for changes...');
        } else {
          gb.info(chalk[any_errored ? 'red' : 'green'](`All tasks complete${gb.start_time ? ` in ${time(dt)}` : ''}, ` +
            `${any_errored ? 'some errored, ': ''}waiting for changes...`));
        }
        gb.start_time = 0;
        if (!any_errored) {
          process.exitCode = 0;
        }
        if (gb.idle_timeout) {
          clearTimeout(gb.idle_timeout);
          gb.idle_timeout = null;
        }
        if (!gb.idle_init_in_progress) {
          gb.idle_timeout = setTimeout(idleCheck.bind(null, gb), TIME_BEFORE_IDLE_INIT);
        }
      }
      gb.emit('done', err_msg);
    }
  }
  if (any_change) {
    scheduleTick(gb);
  }
}

function scheduleTick(gb) {
  if (gb.tick_scheduled) {
    return;
  }
  gb.tick_scheduled = true;
  process.nextTick(tick.bind(null, gb));
}

function doClean(gb) {
  // Do we also want to remove outputs from unknown tasks that still exist in
  //   .gbstate?
  // Do we also want a way to manually specify existing folders that should be
  //   removed that are not referenced by any current or old tasks to help
  //   in migration?
  lnotice('Performing clean...');
  asyncSeries([
    function cleanJobs(next) {
      asyncEachSeries(Object.values(gb.tasks), function (task, next) {
        task.task_state.loadAll(function () {
          let job_states = task.task_state.getAllJobStates();
          asyncEachSeries(Object.keys(job_states), function (job_name, next) {
            let job_state = job_states[job_name];
            let { outputs } = job_state;
            if (empty(outputs)) {
              // just clear job state
              return task.task_state.setJobState(job_name, null, next);
            }
            asyncEachSeries(Object.keys(outputs), function (key, next) {
              gb.files.prune(...parseBucket(key), function (err) {
                if (err) {
                  lerror('Error deleting file:', err);
                  return next(err);
                }
                task.task_state.setJobState(job_name, null, next);
              });
            }, next);
          }, next);
        });
      }, next);
    },
    function cleanTargets(next) {
      asyncEachSeries(Object.keys(gb.config.targets), function (target_name, next) {
        let target_dir = gb.config.targets[target_name];
        readdirRecursive(target_dir, function (err, files) {
          if (err && (err.code === 'ENOENT' || err.code === 'EPERM')) {
            err = null;
          }
          if (err) {
            return next(err);
          }
          if (!files || !files.length) {
            return next();
          }
          if (gb.argv.force) {
            asyncEachSeries(files, function (filename, next) {
              linfo(`  Deleting ${filename}...`);
              deleteFileWithRmdir(filename, next);
            }, next);
          } else {
            lwarn('Warning: Unexpected files found in output target ' +
              `"${target_name}" (${target_dir}):`);
            for (let ii = 0; ii < files.length; ++ii) {
              lnotice(`  ${forwardSlashes(path.relative(target_dir, files[ii]))}`);
            }
            lnotice('Run with --force to remove');
            next();
          }
        });
      }, next);
    },
    function cleanLeftoverState(next) {
      let statedir = gb.config.statedir;
      readdirRecursive(statedir, function (err, files) {
        if (err && (err.code === 'ENOENT' || err.code === 'EPERM')) {
          err = null;
        }
        if (err) {
          return next(err);
        }
        if (!files || !files.length) {
          return next();
        }
        if (gb.argv.force) {
          asyncEachSeries(files, function (filename, next) {
            linfo(`  Deleting ${filename}...`);
            deleteFileWithRmdir(filename, next);
          }, next);
        } else {
          lwarn('Warning: Unexpected files found in state dir ' +
            `"${statedir}":`);
          for (let ii = 0; ii < files.length; ++ii) {
            lnotice(`  ${forwardSlashes(path.relative(statedir, files[ii]))}`);
          }
          lnotice('These may be from tasks that no longer exist, or manual edits. Run with --force to remove');
          next();
        }
      });
    },
  ], function (err) {
    if (err) {
      lerror('Error performing clean:', err);
    } else {
      scheduleTick(gb);
    }
  });
}

function allTasksStopped(gb) {
  let { tasks } = gb;
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (!task.active) {
      continue;
    }
    if (!STATUS_IS_STOPPED[task.status]) {
      return false;
    }
  }
  return true;
}

function fsEvent(gb, watch_generation, event, relative, opt_stat) {
  if (!gb.running || gb.watch_generation !== watch_generation) { // post-stop(), maybe still closing
    return;
  }
  relative = forwardSlashes(relative);
  // Is this change relevant?
  if (!gb.files.fsEventUseful(event, 'source', relative, opt_stat)) {
    ldebug(`Detected spurious file change: ${relative} (${event})`);
    // Scheduling a tick just for testing purposes, maybe don't need, generally?
    gb.was_all_done = false;
    scheduleTick(gb);
    return;
  }

  let key = `source:${relative}`;

  // Find all tasks that depend on this file
  let invalidated_tasks = gb.fs_invalidated_tasks = gb.fs_invalidated_tasks || {};
  let short_list = gb.fs_invalidated_tasks_root = gb.fs_invalidated_tasks_root || {};
  function flagSub(task) {
    if (invalidated_tasks[task.name]) {
      return;
    }
    invalidated_tasks[task.name] = true;
    for (let ii = 0; ii < task.dependors_active.length; ++ii) {
      flagSub(task.dependors_active[ii]);
    }
  }
  function flag(task) {
    task.fs_events[key] = event;
    short_list[task.name] = true;
    flagSub(task);
  }
  let { tasks } = gb;
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (!task.active || !task.task_has_run) {
      continue;
    }
    let { globs_by_bucket, jobs, fs_events } = task;
    if (fs_events[key]) {
      // already care about this file, just re-flag
      flag(task);
      continue;
    }
    let globs = globs_by_bucket.source;
    if (globs) {
      if (micromatch(relative, globs).length) {
        flag(task);
        continue;
      }
    }
    // also check each job if they have an added dep on this file
    // PERFTODO: Can we know if all jobs for this task only depends on the outputs
    //   from other tasks, and not the source that we're watching, and skip this
    //   entirely?
    for (let job_name in jobs) {
      let job = jobs[job_name];
      let job_state = job.last_job_state;
      if (job_state && job_state.deps[key]) {
        flag(task);
        break;
      }
    }
  }

  let impacted = Object.keys(short_list);
  linfo(reload(`Detected file change: ${relative} (${event});` +
    ` impacted tasks: ${impacted.length ? impacted.map((a) => taskname(a)).join(',') : 'none'}`));

  if (!impacted.length) {
    // Possibly the impacted task as not yet run, or is in `inputs` phase,
    //   we want this fs change to be applied after the aborting has finished
    //   and before we re-run it.
    // // Should be safe to let files know immediately, but it wouldn't possibly be in its cache?
    // gb.files.fsEvent(event, 'source', relative, opt_stat);
    // return;
  }

  gb.fs_all_events = gb.fs_all_events || {};
  gb.fs_all_events[key] = [event, 'source', relative, opt_stat];

  if (!gb.aborting) {
    gb.aborting = true;
    gb.abort_start_time = Date.now();
    if (allTasksStopped(gb)) {
      // lsilly(reload('All tasks stopped, short-circuiting abort'));
      finishAbort(gb, true);
    } else {
      linfo(reload('Aborting all running tasks'));
    }
    scheduleTick(gb);
  } else {
    lsilly(reload('Aborting already in progress'));
  }
}

function finishAbort(gb, quiet) {
  assert(gb.aborting);
  gb.aborting = false;
  let now = Date.now();
  let dt = now - gb.abort_start_time;
  if (!quiet) {
    linfo(reload(`Finished aborting in ${time(dt)}`));
  }
  gb.stats_upon_last_abort = { // clone
    ...gb.stats,
  };
  gb.abort_start_time = null;

  let { fs_all_events, fs_invalidated_tasks, fs_invalidated_tasks_root, tasks } = gb;
  assert(fs_all_events);
  gb.fs_all_events = null;

  // Let files know
  for (let key in fs_all_events) {
    gb.files.fsEvent(...fs_all_events[key]);
  }

  if (!gb.start_time) {
    gb.start_time = now;
    if (gb.idle_timeout) {
      clearTimeout(gb.idle_timeout);
      gb.idle_timeout = null;
    }
  }

  for (let task_name in fs_invalidated_tasks) {
    let task = tasks[task_name];
    if (task.status === STATUS_PENDING) {
      // no change
    } else if (STATUS_IS_STOPPED[task.status]) {
      // reset to pending
      taskSetStatus(task, STATUS_PENDING, fs_invalidated_tasks_root[task_name] ?
        'source file changed' : 'dependency pending');
    } else {
      // Not actually aborted?
      assert(false);
    }
  }

  // Also reset all aborted tasks back to pending
  // They may have been interrupted due to an unrelated file change and still need to continue
  // If they are aborted because they depend on something that has error'd, they should immediately
  // swap back to aborted.
  // TODO: Don't do this if we can deduce they are aborted because they are a dependent of an error'd task.
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (task.status === STATUS_ABORTED) {
      // reset to pending
      taskSetStatus(task, STATUS_PENDING, 'reset after abort stabilized');
    }
  }

  gb.was_all_done = false;
}

function setActive(gb, task) {
  if (task.active === gb.generation) {
    return;
  }
  task.active = gb.generation;
  for (let ii = 0; ii < task.deps.length; ++ii) {
    setActive(gb, task.deps[ii]);
  }
}

function isActive(task) {
  return task.active;
}

// Just for testing / debug, probably not useful in production?
GlovBuild.prototype.setActiveTasks = function (task_list) {
  ++this.generation;
  if (typeof task_list === 'string') {
    task_list = [task_list];
  }
  if (!task_list.length) {
    task_list.push('default');
  }
  assert(task_list.length);
  let { tasks } = this;
  let need_clean = false;
  // Flag all tasks as active that we want to be running in this session
  for (let ii = 0; ii < task_list.length; ++ii) {
    let task_name = task_list[ii];
    let task = tasks[task_name];
    if (!task && task_name === 'clean') {
      need_clean = true;
    } else {
      assert(task, `Unknown task "${taskname(task_name)}"`);
      setActive(this, task);
    }
  }

  // Unflag now inactive tasks
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (task.active && task.active !== this.generation) {
      task.active = false;
      assert(STATUS_IS_STOPPED[task.status], `Don't know how to abort task.status=${task.status}`);
    }
  }
  // Prune inactive tasks
  for (let task_name in tasks) {
    let task = tasks[task_name];
    task.dependors_active = task.dependors.filter(isActive);
  }

  return need_clean;
};

GlovBuild.prototype.setDelays = function (delays) {
  for (let key in this.delays) {
    this.delays[key] = Number(delays && delays[key]) || 0;
  }
};

GlovBuild.prototype.go = function (opts) {
  assert(!this.running, 'Already running'); // Should we support changing active tasks while running? Probably not.
  opts = opts || {};
  if (typeof opts === 'string') {
    opts = { tasks: [opts] };
  } else if (Array.isArray(opts)) {
    opts = { tasks: opts };
  }

  // TODO: check no overlap between any of files.bucket_dirs (fully resolved) paths

  const argv = this.argv = minimist(opts.argv || process.argv.slice(2));
  let dry_run = argv.n || argv['dry-run'] || opts.dry_run;
  let watch = (opts.watch || argv.watch || this.config.watch) && argv.watch !== false;
  if (argv.v || argv.verbose) {
    setLogLevel(LOG_DEBUG);
  }
  if (argv.silly) {
    setLogLevel(LOG_SILLY);
  }

  if (!opts.tasks) {
    opts.tasks = argv._ || [];
  }
  let need_clean = this.setActiveTasks(opts.tasks);

  // Display status
  ldebug('Task Tree');
  ldebug('=========');
  dumpDepTree(this);
  ldebug('');
  if (dry_run) {
    return;
  }

  this.running = true;
  process.addListener('exit', this.exit_handler);

  // Start watching for changes immediately
  if (watch) {
    let gen = this.watch_generation = (this.watch_generation || 0) + 1;
    this.watcher = chokidar.watch('.', {
      ignoreInitial: true,
      cwd: this.config.source,
      atomic: false,
    });
    this.watcher.on('add', unpromisify(fsEvent.bind(null, this, gen, 'add')));
    this.watcher.on('change', unpromisify(fsEvent.bind(null, this, gen, 'change')));
    this.watcher.on('unlink', unpromisify(fsEvent.bind(null, this, gen, 'unlink')));
  }

  // All tasks should be flagged as pending
  if (need_clean) {
    doClean(this);
  } else {
    scheduleTick(this);
  }
  return this;
};

GlovBuild.prototype.stop = function (next) {
  assert(this.running);
  process.removeListener('exit', this.exit_handler);
  this.running = false;
  if (this.idle_timeout) {
    clearTimeout(this.idle_timeout);
    this.idle_timeout = null;
  }
  let left = 1;
  function done() {
    if (!--left) {
      if (next) {
        next();
      }
    }
  }
  if (this.watcher) {
    ++left;
    this.watcher.close().then(unpromisify(done));
  }
  for (let key in this.tasks) {
    this.tasks[key].reset();
  }
  this.reset();
  this.resetFiles();
  done();
};

function create() {
  return new GlovBuild();
}
exports.create = create;
