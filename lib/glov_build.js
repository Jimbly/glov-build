const assert = require('assert');
const child_process = require('child_process');
const chalk = require('chalk');
const chokidar = require('chokidar');
const crc32 = require('./crc32.js');
const { dumpDepTree } = require('./debug.js');
const { EventEmitter } = require('events');
const fast_glob = require('fast-glob');
const { filesCreate, isBuildFile, DELETED_TIMESTAMP } = require('./files.js');
const { filesForkedCreate } = require('./files_forked.js');
const { asyncEach, asyncEachLimit, asyncEachSeries, asyncLimiter, asyncSeries } = require('glov-async');
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
const xxhashmod = require('xxhash-wasm');

const fg = callbackify(fast_glob);

const fork = process.argv.includes('--fork');

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

const ASYNC_DEFAULT = 'default'; // obeys config.parallel.tasks (for most tasks)
const ASYNC_INPROC = 'inproc'; // overrides config.parallel.tasks (for network IO-bound tasks)
const ASYNC_FORK = 'fork'; //   also runs in another process (for CPU-bound tasks, high overhead)

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

let worker_id;
function log(level, msg, ...args) {
  if (level < log_level) {
    return;
  }
  if (fork) {
    if (log_level <= LOG_DEBUG) {
      msg = `[worker:${worker_id || process.pid}] ${msg}`;
    }
    process.send({
      cmd: 'log',
      level, msg, args,
    });
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
  this.forked_response_cb = {};
  this.forked_response_last_id = 0;
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

GlovBuild.prototype.ASYNC_DEFAULT = ASYNC_DEFAULT;
GlovBuild.prototype.ASYNC_INPROC = ASYNC_INPROC;
GlovBuild.prototype.ASYNC_FORK = ASYNC_FORK;

GlovBuild.prototype.reset = function () {
  // Default configuration options
  this.config = {
    root: '.',
    statedir: './.gbstate',
    targets: {},
    watch: false,
    parallel: {
      tasks: 1,
      tasks_async: 8,
      jobs: 4,
      jobs_async: 8,
    },
    allow_fork: true,
  };
  this.tasks = {};
  this.tasks_finalized = false;
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
    crc_calcs: 0,
  };
  this.stats_upon_last_abort = null;
  if (this.files) {
    this.files.resetStats();
  }
};


const invalid_file_char = /[/\\'"`$%:]/;

function hashReplacer(key, value) {
  if (typeof value === 'object') {
    return value;
  }
  return String(value); // especially Functions
}

function addDep(task, bucket) {
  if (bucket !== 'source' && task.deps.indexOf(bucket) === -1) {
    task.deps.push(bucket);
  }
}

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
  this.did_gather_globs = false;
  this.did_init = false; // Has run init for this execution pass
  this.ever_did_init = false; // Has ever run init for the history of this process
  this.post_init = null;
  this.last_run_time = Date.now();
  if (!fork) {
    this.child = null;
    this.waiting_on_fork = 0;
    this.post_waiting_err = null;
    this.post_waiting = null;
  }

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
  this.read = opts.read !== false;
  this.async = opts.async === ASYNC_INPROC ? ASYNC_INPROC : opts.async === ASYNC_FORK ? ASYNC_FORK : ASYNC_DEFAULT;
  this.async_task = opts.async_task || this.name;
  this.version = opts.version || [];
  if (Array.isArray(this.version)) {
    // If no version specified, or, version is an array of references,
    //   add references to all of the known parameters that would require
    //   reprocessing upon change.
    this.version.push(opts.func, opts.init, opts.finish, opts.target);
    if (this.type === gb.ALL) {
      // Hash the input list, so an ALL task re-runs if an input is no longer specified (but still exists)
      this.version.push(opts.input);
    }
    this.version = `CRC#${crc32(JSON.stringify(this.version, hashReplacer)).toString(16)}`;
  }

  assert(this.name, 'Task missing required parameter "name"');
  assert(!this.name.match(invalid_file_char),
    `Task "${taskname(this.name)}": name must be a valid, safe file name (none of /\\'"\`$%:)`);
  assert(Array.isArray(this.deps),
    `Task "${taskname(this.name)}": "deps" must be an Array, found ${typeof this.deps}`);

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
        // depending on 'source' bucket
      } else {
        let bucket = split[0];
        // let glob = split[1];
        addDep(this, bucket);
      }
    }

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

function gatherGlobs(gb, task) {
  if (task.did_gather_globs) {
    return;
  }
  task.did_gather_globs = true;
  let globs_by_bucket = {};
  function addSourceGlob(bucket, glob) {
    globs_by_bucket[bucket] = globs_by_bucket[bucket] || [];
    globs_by_bucket[bucket].push(glob);
    if (bucket === 'source') {
      return;
    }
    let source_task = gb.tasks[bucket];
    if (source_task && !source_task.input) {
      // it's a meta task, with no function, so, add it's sources as our sources
      gatherGlobs(gb, source_task);
      assert(!source_task.func);
      assert(source_task.deps.length);
      for (let jj = 0; jj < source_task.deps.length; ++jj) {
        let dep_task_name = source_task.deps[jj];
        assert.equal(typeof dep_task_name, 'string');
        // important:  also depend directly on the sub-tasks, so that they
        // get us added as a dependor for propagating fs events
        addDep(task, dep_task_name);
        addSourceGlob(dep_task_name, glob);
      }
    }
  }

  if (task.input) {
    assert(Array.isArray(task.input)); // checked earlier
    for (let ii = 0; ii < task.input.length; ++ii) {
      let input = task.input[ii];
      assert(typeof input === 'string'); // checked earlier
      let split = input.split(':');
      assert(split.length <= 2); // checked earlier
      if (split.length === 1) {
        addSourceGlob('source', input);
      } else {
        let bucket = split[0];
        let glob = split[1];
        addSourceGlob(bucket, glob);
      }
    }
  }
  task.globs_by_bucket = globs_by_bucket;
}

BuildTask.prototype.reset = function () {
  this.active = false; // depended on by an a active task
  this.status = STATUS_PENDING;
  this.last_time = Date.now();
  this.err = null;
  this.task_state = createTaskState({ gb: this.gb, dir: this.taskdir, name: this.name });
  this.jobs = null;
  this.task_has_run = false;
  this.task_first_run_errored = false;
  this.fs_events = {};
  taskEndChild(this);
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

// For adding a new target at run-time, does what happens in configure + resetFiles
GlovBuild.prototype.addTarget = function (key, folder) {
  assert(!this.config.targets[key], `Target "${key}" already registered`);
  this.config.targets[key] = forwardSlashes(folder);
  assert(!this.files.getBucketDir(key), `Target "${key}": must not be a reserved name`);
  this.files.addBucket(key, this.config.targets[key]);
};

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
  this.job_queue_async = asyncLimiter(this.config.parallel.jobs_async);
};

GlovBuild.prototype.getSourceRoot = function () {
  return this.config.source;
};

GlovBuild.prototype.getDiskPath = function (key) {
  return this.files.getDiskPath(...parseBucket(key));
};

GlovBuild.prototype.resetFiles = function () {
  if (this.isFork()) {
    this.files = filesForkedCreate(this);
  } else {
    this.files = filesCreate(this);
  }
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
  assert(!this.tasks_finalized, 'Cannot add tasks after starting build');
  assert(!this.tasks[task.name], `Task "${taskname(task.name)}": task already declared`);
  assert(!this.config.targets[task.name], `Task "${taskname(task.name)}": must not be named the same as a target`);
  assert(!this.files.getBucketDir(task.name), `Task "${taskname(task.name)}": must not be a reserved name`);
  this.files.addBucket(task.name, task.intdir);

  this.tasks[task.name] = task;
};

GlovBuild.prototype.tasksFinalize = function () {
  if (this.tasks_finalized) {
    return;
  }
  // Build input globs (may have been registered before their dependencies)
  // This may also add new dependencies
  for (let task_name in this.tasks) {
    let task = this.tasks[task_name];
    gatherGlobs(this, task);
  }

  for (let task_name in this.tasks) {
    let task = this.tasks[task_name];

    // Validate inter-task dependencies
    // convert dep names to dep references
    // determine the dependency depth ("phase", just for UI?)
    let max_phase = 0;
    for (let ii = 0; ii < task.deps.length; ++ii) {
      let dep_name = task.deps[ii];
      assert.equal(!dep_name || typeof dep_name, 'string'); // Called twice?
      let dep = this.tasks[dep_name];
      assert(dep,
        `Task "${taskname(task.name)}": depends on unknown task "${taskname(dep_name)}"`);
      task.deps[ii] = dep;
      dep.dependors.push(task);
      max_phase = max(max_phase, dep.phase);
    }
    task.phase = max_phase + 1;

    task.deps.sort(cmpTaskPhase);
  }
  this.tasks_finalized = true;
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
  if (!fork) {
    this.job_state = null;
    this.last_job_state = task.task_state.getJobState(this.name);
  }
  this.job_has_run = false;
  this.dirty = false;
  this.executing = false;
}
function fileSerializeForFork(file) {
  return file.serializeForFork();
}
BuildJob.prototype.serializeForFork = function (file_list) {
  function serializeFile(file) {
    let idx = file_list.indexOf(file);
    if (idx === -1) {
      file_list.push(file);
      idx = file_list.length - 1;
    }
    return idx;
  }

  return {
    name: this.name,
    files_all: this.files_all.map(serializeFile), // note: every file pushed to file_list
    files_base: this.files_base.map(serializeFile), // note: only references existing files
    files_updated: this.files_updated.map(serializeFile), // note: may also push deleted files!
  };
};
BuildJob.prototype.deserializeForFork = function (data, files) {
  function lookupFile(idx) {
    return files[idx];
  }
  assert.equal(this.name, data.name);
  this.dirty = true;
  this.files_all = data.files_all.map(lookupFile);
  this.files_base = data.files_base.map(lookupFile);
  this.files_updated = data.files_updated.map(lookupFile);
};
BuildJob.prototype.serializeForParent = function () {
  function serializeOutput(file) {
    return {
      relative: file.relative,
      contents: file.contents,
    };
  }
  let output_queue = {};
  for (let key in this.output_queue) {
    let file = this.output_queue[key];
    output_queue[key] = serializeOutput(file);
  }
  let ret = {
    task_name: this.task.name,
    job_name: this.name,
    error_files: this.error_files,
    output_queue,
    errors: this.errors,
    warnings: this.warnings,
  };

  this.output_queue = null;
  this.warnings = null;
  this.errors = null;
  this.error_files = null;

  return ret;
};
BuildJob.prototype.deserializeForParent = function (data) {
  this.error_files = data.error_files;
  assert(!this.output_queue);
  this.output_queue = data.output_queue;
  this.errors = data.errors;
  this.warnings = data.warnings;
};
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

let xxhashobj;
function withXxhash(fn) {
  if (xxhashobj) {
    fn(xxhashobj);
  } else {
    xxhashmod().then(function (obj) {
      xxhashobj = obj;
      fn(xxhashobj);
    });
  }
}

// errors added to job.errors
function jobOutputFiles(job, cb) {
  assert(!fork);
  // updates file.timestamp in BuildFiles
  let who = `${job.task.name}:${job.name}`;
  let count = 0;
  let to_prune = {};
  assert(!fork);
  let last_outputs = job.last_job_state && job.last_job_state.outputs || {};
  for (let key in last_outputs) {
    to_prune[key] = true;
  }
  withXxhash(function (xxhash) {
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
      let unchanged = false;
      let last_data = last_outputs[buildkey];
      let crc;
      if (file.is_unchanged) {
        assert(last_data, `Job output signaled is_unchanged on ${buildkey}, but this is a new file`);
        unchanged = true;
        crc = last_data.crc;
      } else {
        // crc = crc32(file.contents);
        crc = xxhash.h32Raw(file.contents); // decently faster than crc32()
        job.gb.stats.crc_calcs++;
        unchanged = (last_data && last_data.crc === crc);
      }
      if (unchanged) {
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
        let file = job.gb.files.getPre(...parseBucket(key));
        if (file.who && file.who !== who) {
          job.warn(`output ${key} from this job should be pruned, but was recently written by "${file.who}", not pruning.` +
            '  This is highly unusual, but may happen if a task or input has changed so that a new job outputs' +
            ' what an old job used to output.');
          next();
        } else {
          taskOutputFsEvent(job.task, 'unlink', key);
          job.gb.files.prune(...parseBucket(key), next);
        }
      }, function () {
        job.output_queue = null;
        cb(count, prune_count);
      });
    });
  });
}
BuildJob.prototype.jobDone = function (next) {
  this.job_has_run = true;
  if (fork) {
    process.send({
      cmd: 'job_done',
      ...this.serializeForParent(),
    });
    return next();
  }
  assert(this.job_state !== this.last_job_state); // no longer gets here if nothing changed?
  this.dirty = false;
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
    let err = new Error(`Job is outputting the same file ("${key}") twice`);
    if (isBuildFile(file)) {
      this.error(file, err);
    } else {
      this.error(err);
    }
  } else {
    this.output_queue[key] = file;
  }
};
BuildJob.prototype.getOutputQueue = function () {
  assert(this.output_queue, 'job.getOutputQueue() is only allowed during job execution');
  return this.output_queue;
};

BuildJob.prototype.depReset = function () {
  let expected_deps = {};
  for (let ii = 0; ii < this.files_base.length; ++ii) {
    expected_deps[this.files_base[ii].key] = 1;
  }
  function expected(file) {
    return expected_deps[file.key];
  }
  if (fork) {
    // Just filter lists, and parent process will modify job state
    // Note: preserves sort state
    this.files_all = this.files_all.filter(expected);
    this.files_updated = this.files_updated.filter(expected);
    process.send({
      cmd: 'job_dep_reset',
      task_name: this.task.name,
      job_name: this.name,
    });
    return;
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
  assert(!fork);
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

function depAddInternalFinish(job, file) {
  assert(job.files_all.indexOf(file) === -1);
  job.files_all.push(file);
  job.files_updated.push(file);
  job.need_sort = true;
}

function depAddInternal(job, bucket, relative, cb) {
  job.gb.files.get(bucket, relative, function (err, file) {
    assert.equal(file.err, err);
    depAddInternalFinish(job, file);
    job.job_state.deps[file.key] = file.timestamp; // will be -1 if `file.err`
    cb(file);
  });
}

BuildJob.prototype.depAdd = function (name, cb) {
  assert(this.executing, 'job.depAdd() called on job that is no longer executing!');
  name = forwardSlashes(name);
  let [bucket, relative] = parseBucket(name);
  let source_task = this.gb.tasks[bucket];
  if (source_task && source_task.target) {
    bucket = source_task.target;
  }
  let need_late_dep_check = false;
  if (bucket !== 'source') {
    // must reference a dependency of this task
    if (this.gb.config.targets[bucket]) {
      // references a target, once we've located the file, make sure we depend
      // on the job that output it
      need_late_dep_check = true;
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
    if (file.key === key) {
      return cb(file.err, file);
    }
  }

  let adding = this.deps_adding[key] = [cb];

  let job = this;
  function onFile(file) {
    assert.equal(job.deps_adding[key], adding);
    delete job.deps_adding[key];

    if (need_late_dep_check && file.who) {
      let pair = file.who.split(':');
      if (pair.length === 2) {
        let bucket = pair[0];
        // how does the file exist if it's not a task?  shouldn't be possible
        assert(job.gb.tasks[bucket],
          `Job "${job.name}" in Task "${taskname(job.task.name)}" references output from "${bucket}"` +
          ` via "${name}" which is not a declared task or target`);
        if (!taskDependsOnTask(job.task, bucket)) {
          job.error(`References output from "${bucket}"` +
            ` via "${name}" which is not an explicit dependency`);
        }
      }
      // Note: if we don't have file.who (e.g. because the source task was not
      //   loaded in this run), we miss this check as we have no idea where
      //   a given output file came from - let's hope the user doesn't ignore
      //   the error the first time it pops up.
    }

    for (let ii = 0; ii < adding.length; ++ii) {
      adding[ii](file.err, file);
    }
  }

  if (fork) {
    let resp_id = job.gb.onForkedResponse((obj) => {
      let file = job.gb.files.addFiles([obj.file])[0];
      depAddInternalFinish(job, file);
      onFile(file);
    });
    process.send({
      cmd: 'job_dep_add',
      task_name: job.task.name,
      job_name: job.name,
      bucket,
      relative,
      resp_id,
    });
  } else {
    depAddInternal(job, bucket, relative, onFile);
  }
};

function delayRun(gb, key, fn, ...args) {
  if (gb.delays[key]) {
    setTimeout(fn.bind(null, ...args), gb.delays[key]);
  } else {
    fn(...args);
  }
}

function taskStart(gb, task) {
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
      // We failed very early from a low-level error (presumably race condition
      // while starting up during a git branch switch or something), we cannot
      // just abort now, as we have not started prepping the jobs which are
      // needed to handle reloads/watch events. Instead, just treat it as if
      // it has not ran at all, it'll start from scratch next time (and
      // likely not get the low-level error).
      task.task_has_run = false;
      task.task_first_run_errored = true;
      return taskSetErr(task, err);
    }
    task.task_first_run_errored = false;
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
    }
  }

  asyncEachLimit(Object.values(jobs), 1, function (job, next) {
    job.isUpToDate(function (err) {
      if (err) {
        // needs updating
        job.dirty = true;
      } else {
        // Register outputs for valid jobs, so conflicting output detection can catch them
        let who =`${task.name}:${job.name}`;
        let job_state = job_states[job.name];
        for (let key in job_state.outputs) {
          task.gb.files.getPre(...parseBucket(key)).who = who;
        }
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
  assert(!fork);
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

function taskInitSendToFork(task, next) {
  let child = taskGetChildProc(task);
  task.ever_did_init = true;
  let resp_id = task.gb.onForkedResponse(next);
  child.send({
    cmd: 'task_init',
    task_name: task.name,
    resp_id,
  });
}

function taskInit(task, next) {
  if (!fork && task.async === ASYNC_FORK && task.gb.config.allow_fork) {
    return taskInitSendToFork(task, next);
  }
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
    delayRun(gb, 'deps', taskExecute, gb, task, dirty_jobs);
  });
}


function taskEndChild(task) {
  if (task.child) {
    task.child.kill();
    task.child = null;
  }
}

function killAllChildren(gb) {
  let { tasks } = gb;
  for (let task_name in tasks) {
    taskEndChild(tasks[task_name]);
  }
}

function taskCompleteFromFork(gb, task, obj) {
  assert.equal(obj.task_name, task.name);
  taskExecuteComplete(gb, task, task.post_waiting_err || obj.err);
}

let last_worker_id = 0;
function taskStartFork(gb, task_name_in) {
  // Note: forktask parameter is simply for debugging (can see at the OS level which process is for which task)
  let child = child_process.fork(process.argv[1], ['--fork'].concat(gb.argv_raw).concat(['--forktask', task_name_in]), {
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'], // avoid Node bug #56537
  });
  child.send({
    cmd: 'init',
    worker_id: ++last_worker_id,
  });
  // child.on('error', (err) => { throw err; } );
  child.on('message', function (obj) {
    if (obj && obj.cmd) {
      let { task_name, job_name } = obj;
      let task = gb.tasks[task_name];
      let job = task && task.jobs[job_name];
      // eslint-disable-next-line default-case
      switch (obj.cmd) {
        case 'log':
          log(obj.level, obj.msg, ...obj.args);
          break;
        case 'job_dep_reset':
          assert(task);
          assert.equal(task.status, STATUS_RUNNING);
          assert(job);
          job.depReset();
          break;
        case 'job_dep_add': {
          assert(task);
          assert.equal(task.status, STATUS_RUNNING);
          assert(job); // exists
          assert(job.dirty); // and is one we expect to be executing
          let { bucket, relative, resp_id } = obj;
          depAddInternal(job, bucket, relative, (file) => {
            child.send({
              cmd: 'response',
              resp_id,
              file: file.serializeForFork(),
            });
          });
        } break;
        case 'job_done':
          assert.equal(task.status, STATUS_RUNNING);
          assert(job);
          job.deserializeForParent(obj);
          ++task.waiting_on_fork;
          job.jobDone((err) => {
            if (err) {
              task.post_waiting_err = err;
            }
            --task.waiting_on_fork;
            if (!task.waiting_on_fork && task.post_waiting) {
              let cb = task.post_waiting;
              task.post_waiting = null;
              cb();
            }
          });
          break;
        case 'task_complete': {
          let { stats } = obj;
          for (let key in stats) {
            gb.stats[key] += stats[key];
          }
          if (task.waiting_on_fork) {
            task.post_waiting = taskCompleteFromFork.bind(null, gb, task, obj);
          } else {
            taskCompleteFromFork(gb, task, obj);
          }
        } break;
        case 'response': {
          let resp_id = obj.resp_id;
          let cb = gb.forked_response_cb[resp_id];
          delete gb.forked_response_cb[resp_id];
          cb(obj);
        } break;
      }
    }
  });
  return child;
}

function taskGetChildProc(task) {
  let worker_task = task.gb.tasks[task.async_task];
  if (!worker_task.child) {
    worker_task.child = taskStartFork(task.gb, task.name);
  }
  return worker_task.child;
}

function taskExecuteSendToFork(task) {
  assert.equal(task.status, STATUS_RUNNING);
  let { dirty_jobs } = task;
  let child = taskGetChildProc(task);
  let file_list = [];
  let ser_dirty_jobs = dirty_jobs.map((job) => job.serializeForFork(file_list));
  let ser_file_list = file_list.map(fileSerializeForFork);
  ldebug(`  Task "${taskname(task.name)}": Sending ${ser_dirty_jobs.length} jobs,` +
    ` ${ser_file_list.length} files to worker`);
  task.ever_did_init = true;
  child.send({
    cmd: 'task_execute',
    task_name: task.name,
    dirty_jobs: ser_dirty_jobs,
    file_list: ser_file_list,
  });
}

function taskExecuteInFork(gb, task_data) {
  let { task_name, dirty_jobs: ser_dirty_jobs, file_list } = task_data;
  let task = gb.tasks[task_name];
  assert(task);
  let files_mapped = gb.files.addFiles(file_list);

  // Convert serialized job data to actual jobs with references to BuildFiles
  let { jobs } = task;
  if (!jobs) {
    jobs = task.jobs = {};
  }
  let dirty_jobs = [];
  for (let ii = 0; ii < ser_dirty_jobs.length; ++ii) {
    let ser_job = ser_dirty_jobs[ii];
    let { name } = ser_job;
    let job = jobs[name];
    if (!job) {
      job = jobs[name] = new BuildJob(gb, task, name, []);
    }
    job.deserializeForFork(ser_job, files_mapped);
    dirty_jobs.push(job);
  }

  task.did_init = !(task.init || task.finish);
  task.post_init = null;
  asyncEachLimit(dirty_jobs, ASYNC_LIMIT, function (job, next) {
    let queue = task.async === ASYNC_DEFAULT ? gb.job_queue : gb.job_queue_async;
    queue(function (next) {
      if (gb.aborting) {
        return next();
      }
      jobExecute(gb, task, job, next);
    }, next);
  }, function (err) {
    if (task.finish && task.did_init) {
      task.finish();
    }
    // send back to parent
    let stats = gb.stats;
    gb.resetStats();
    process.send({
      cmd: 'task_complete',
      task_name,
      err,
      stats,
    });
  });
}

function taskInitInFork(gb, obj) {
  let { task_name, resp_id } = obj;
  let task = gb.tasks[task_name];
  assert(task);
  taskInit(task, function () {
    process.send({
      cmd: 'response',
      resp_id,
    });
  });
}

function taskExecuteComplete(gb, task, err) {
  let { jobs, dirty_jobs } = task;
  // Re-output any warnings/errors from jobs that were not dirty, but have
  //  warnings/errors
  let dirty_keys = {};
  for (let ii = 0; ii < dirty_jobs.length; ++ii) {
    dirty_keys[dirty_jobs[ii].name] = true;
  }
  let error_count = 0;
  for (let job_name in jobs) {
    let job = jobs[job_name];
    if (dirty_keys[job_name]) {
      error_count += job.errors.length;
      continue;
    }
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
}

function resetDirtyJob(job) {
  let deps = {}; // filename (bucket:relative) => timestamp
  for (let ii = 0; ii < job.files_all.length; ++ii) {
    let buildfile = job.files_all[ii];
    deps[buildfile.key] = buildfile.timestamp;
  }
  job.job_state = {
    deps,
    outputs: {},
  };
}

function taskExecute(gb, task, dirty_jobs) {
  assert.equal(task.status, STATUS_PREPARING_DEPS);

  if (gb.aborting) {
    return taskAbort(task);
  }

  let { jobs } = task;
  task.dirty_jobs = dirty_jobs;
  taskSetStatus(task, STATUS_RUNNING, `${dirty_jobs.length}/${Object.keys(jobs).length} jobs`);
  ++gb.stats.phase_run;

  // Reset counters for run-time stats
  task.count_outputs = 0;
  task.count_deps = 0;
  task.last_run_time = Date.now();

  if (!dirty_jobs.length) {
    return taskExecuteComplete(gb, task);
  }

  dirty_jobs.forEach(resetDirtyJob);

  if (task.async === ASYNC_FORK && gb.config.allow_fork) {
    return taskExecuteSendToFork(task);
  }

  task.did_init = !(task.init || task.finish);
  task.post_init = null;
  asyncEachLimit(dirty_jobs, ASYNC_LIMIT, function (job, next) {
    let queue = task.async === ASYNC_DEFAULT ? gb.job_queue : gb.job_queue_async;
    queue(function (next) {
      if (gb.aborting) {
        return next();
      }
      jobExecute(gb, task, job, next);
    }, next);
  }, function (err) {
    if (task.finish && task.did_init) {
      task.finish();
    }
    taskExecuteComplete(gb, task, err);
  });
}

function jobExecute(gb, task, job, next) {
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

  assert(!job.output_queue);
  job.output_queue = {};
  job.warnings = [];
  job.errors = [];
  job.error_files = {};
  taskInit(task, function () {
    for (let ii = 0; ii < job.files_updated.length; ++ii) {
      let file = job.files_updated[ii];
      assert(!task.read || file.err || file.contents); // should already be loaded
    }
    gb.stats.jobs++;
    let is_done = false;
    job.executing = true;
    function done(err) {
      job.executing = false;
      assert(!is_done, `done() called twice for Task "${taskname(task.name)}", job "${job.name}"`);
      is_done = true;
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
  assert(!fork);
  gb.idle_timeout = null;
  let { tasks } = gb;
  let candidate;
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (task.init && !task.ever_did_init && task.active) {
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


GlovBuild.prototype.getDebugState = function () {
  let { tasks } = this;
  let ret = null;
  let error_count = 0;
  let warning_count = 0;
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (!task.active) {
      continue;
    }
    let by_job;
    let { jobs } = task;
    for (let job_name in jobs) {
      let job = jobs[job_name];
      let { warnings, errors } = job;
      if (warnings.length || errors.length) {
        by_job = by_job || {};
        by_job[job_name] = {};
        if (warnings.length) {
          warning_count += warnings.length;
          by_job[job_name].warnings = warnings;
        }
        if (errors.length) {
          error_count += errors.length;
          by_job[job_name].errors = errors;
        }
      }
    }
    let task_err = task.status === STATUS_ERROR && task.err;
    if (by_job || task_err) {
      let task_state = {
        jobs: by_job || {},
      };
      if (task_err) {
        if (!by_job) {
          ++error_count;
        }
        task_state.err = task_err;
      }
      ret = ret || {};
      ret[task_name] = task_state;
    }
  }
  if (ret) {
    return {
      tasks: ret,
      error_count,
      warning_count,
    };
  }
  return null;
};


function tick(gb) {
  gb.tick_scheduled = false;
  let { tasks, aborting, was_all_done } = gb;
  let all_tasks_done = true;
  let any_change = false;
  let any_errored = false;
  let tasks_inproc = {
    count: 0,
    avail: gb.config.parallel.tasks,
  };
  let tasks_async = {
    count: 0,
    avail: gb.config.parallel.tasks_async,
  };
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
        if (task.async === ASYNC_DEFAULT) {
          tasks_inproc.count++;
        } else {
          tasks_async.count++;
        }
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
    let task_set = (task.async === ASYNC_DEFAULT) ? tasks_inproc : tasks_async;
    if (task_set.count >= task_set.avail) {
      continue;
    }
    ++task_set.count;
    taskStart(gb, task);
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
      } else {
        killAllChildren(gb);
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

function abortingUpdateForkedTasks(gb) {
  let { tasks, aborting } = gb;
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (task.child) {
      // Note: this is not particularly effective for small numbers of CPU-bound
      //   tasks, as they are likely already in the event/job queues and busy
      //   and will all finish before this event is dispatched.
      task.child.send({
        cmd: 'aborting',
        value: aborting,
      });
    }
  }
}

function fsEvent(gb, watch_generation, event, relative, opt_stat) {
  assert(!fork);
  if (!gb.running || gb.watch_generation !== watch_generation) { // post-stop(), maybe still closing
    return;
  }
  relative = forwardSlashes(relative);
  let key = `source:${relative}`;
  // Is this change relevant?
  if (!gb.files.fsEventUseful(event, 'source', relative, opt_stat) &&
    !(gb.fs_all_events && gb.fs_all_events[key])
  ) {
    ldebug(`Detected spurious file change: ${relative} (${event})`);
    // Scheduling a tick just for testing purposes, maybe don't need, generally?
    gb.was_all_done = false;
    scheduleTick(gb);
    return;
  }


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
    if (!task.active || !task.task_has_run && !task.task_first_run_errored) {
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
      abortingUpdateForkedTasks(gb);
    }
    scheduleTick(gb);
  } else {
    lsilly(reload('Aborting already in progress'));
  }
}

function finishAbort(gb, quiet) {
  assert(gb.aborting);
  gb.aborting = false;
  abortingUpdateForkedTasks(gb);
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
  gb.fs_invalidated_tasks = null;
  gb.fs_invalidated_tasks_root = null;

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
  assert(!fork);
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

GlovBuild.prototype.isFork = function () {
  return fork;
};

GlovBuild.prototype.onForkedResponse = function (cb) {
  let resp_id = ++this.forked_response_last_id;
  this.forked_response_cb[resp_id] = cb;
  return resp_id;
};

function fixBuggyChokidar(watcher) {
  // eslint-disable-next-line no-underscore-dangle
  let orig = watcher._throttle.bind(watcher);
  // eslint-disable-next-line no-underscore-dangle
  watcher._throttle = function (actiontype, filename, timeout) {
    if (actiontype !== 'change' && actiontype !== 'add') {
      return orig(actiontype, filename, timeout);
    }
    return true;
  };
}

GlovBuild.prototype.go = function (opts) {
  assert(!this.running, 'Already running'); // Should we support changing active tasks while running? Probably not.
  this.tasksFinalize();
  opts = opts || {};
  if (typeof opts === 'string') {
    opts = { tasks: [opts] };
  } else if (Array.isArray(opts)) {
    opts = { tasks: opts };
  }

  // TODO: check no overlap between any of files.bucket_dirs (fully resolved) paths

  this.argv_raw = opts.argv || process.argv.slice(2);
  const argv = this.argv = minimist(this.argv_raw);
  let dry_run = argv.n || argv['dry-run'] || opts.dry_run;
  let watch = (opts.watch || argv.watch || this.config.watch) && argv.watch !== false;
  if (argv.v || argv.verbose) {
    setLogLevel(LOG_DEBUG);
  }
  if (argv.silly) {
    setLogLevel(LOG_SILLY);
  }
  if (argv.fork === false) { // --no-fork
    this.config.allow_fork = false;
  }

  if (fork) {
    process.on('message', (m) => {
      if (m && m.cmd) {
        switch (m.cmd) { // eslint-disable-line default-case
          case 'init':
            worker_id = m.worker_id;
            break;
          case 'aborting':
            this.aborting = m.value;
            break;
          case 'task_execute':
            taskExecuteInFork(this, m);
            break;
          case 'task_init':
            taskInitInFork(this, m);
            break;
          case 'response': {
            let resp_id = m.resp_id;
            let cb = this.forked_response_cb[resp_id];
            delete this.forked_response_cb[resp_id];
            cb(m);
          } break;
        }
      }
    });
    return;
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
    fixBuggyChokidar(this.watcher);
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
  assert(!fork);
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
