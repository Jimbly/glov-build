const assert = require('assert');
const async = require('async');
const chalk = require('chalk');
const { dumpDepTree } = require('./debug.js');
const { EventEmitter } = require('events');
const fast_glob = require('fast-glob');
const { filesCreate } = require('./files.js');
const { max } = Math;
const minimist = require('minimist');
const path = require('path');
const readdirRecursive = require('recursive-readdir');
const { createTaskState } = require('./task_state.js');
const { callbackify, cmpTaskPhase, deleteFileWithRmdir, empty, forwardSlashes, merge } = require('./util.js');
const util = require('util');

const fg = callbackify(fast_glob);

// general path mapping (all via files.bucket_dirs)
//   foo/bar.baz -> config.source
//   taskname:foo/bar.baz -> task.outdir
//   targetname:foo/bar.baz -> config.targets[targetname]

const STATUS_PENDING = 'pending';
const STATUS_PREPARING_INPUTS = 'inputs';
const STATUS_PREPARING_DEPS = 'deps';
const STATUS_RUNNING = 'running';
const STATUS_DONE = 'done';
const STATUS_ERROR = 'error';
const STATUS_ABORTED = 'aborted';

const ASYNC_LIMIT = 4;

const ALL = 'ALL'; // func ran on all inputs at once
const SINGLE = 'SINGLE'; // func ran on each input
function GlovBuild() {
  // Default configuration options
  this.config = {
    root: '.',
    statedir: './.gbstate',
    targets: {},
  };
  this.tasks = {};
  this.reset();
}
util.inherits(GlovBuild, EventEmitter);
GlovBuild.prototype.ALL = ALL;
GlovBuild.prototype.SINGLE = SINGLE;
GlovBuild.prototype.reset = function () {
  this.stats = {
    files_deleted: 0,
    files_updated: 0,
    warnings: 0,
    errors: 0,
    jobs: 0,
  };
  this.was_all_done = false;
  //this.resetFiles();
};

const invalid_file_char = /[/\\'"`$%:]/;

let last_task_uid=0;
function BuildTask(gb, opts) {
  this.gb = gb;
  // Run-time state
  this.reset();
  this.phase = 0; // for the UI, where it fits horizontally; how deep is the dep tree to us
  this.uid = ++last_task_uid;
  this.dependors = [];
  this.dependors_active = null; // filtered by active
  this.task_state = null; // task/job state tracking
  this.outdir = null; // location for output files, may be taskdir/out or may be a (shared) target

  // Validate and parse task options
  assert(opts);
  this.name = opts.name;
  this.deps = (opts.deps || []).slice(0);
  this.type = opts.type;
  this.input = opts.input;
  this.func = opts.func;
  this.target = opts.target;

  assert(this.name, 'Task missing required parameter "name"');
  assert(!this.name.match(invalid_file_char),
    `Task "${this.name}": name must be a valid, safe file name (none of /\\'"\`$%:)`);
  assert(Array.isArray(this.deps),
    `Task "${this.name}": "deps" must be an Array, found ${typeof this.deps}`);

  if (this.input) {
    if (typeof this.input === 'string') {
      this.input = [this.input];
    }
    assert(Array.isArray(this.input),
      `Task "${this.name}": "input" must be null, a string, or an Array, found ${typeof this.input}`);
    assert(this.input.length,
      `Task "${this.name}": "input" array must not be empty (omit if task has no inputs)`);
    for (let ii = 0; ii < this.input.length; ++ii) {
      let input = this.input[ii];
      assert(typeof input === 'string',
        `Task "${this.name}": entries in "input" must be strings, found ${typeof input}`);
      let split = input.split(':');
      assert(split.length <= 2,
        `Task "${this.name}": entries in "input" must be of the form "glob" or "task:glob", found "${input}"`);
      if (split.length === 2) {
        let dep_name = split[0];
        if (this.deps.indexOf(dep_name) === -1) {
          this.deps.push(dep_name);
        }
      }
    }

    assert(this.type === ALL || this.type === SINGLE,
      `Task "${this.name}": "type" must be gb.SINGLE, gb.ALL, found ${this.type}`);

    assert(typeof this.func === 'function',
      `Task "${this.name}": "func" must be of type function, found ${typeof this.func}`);

    if (this.target) {
      assert(typeof this.target === 'string',
        `Task "${this.name}": "target" must be of type string, found ${typeof this.target}`);
    }
  } else {
    // no input, must at least have deps!
    assert(this.deps && this.deps.length,
      `Task "${this.name}": Task must specify at least "deps" or "input"`);

    assert(!this.func,
      `Task "${this.name}": A task with no inputs must not specify a "func"`);

    assert(!this.target,
      `Task "${this.name}": A task with no inputs must not specify a "target"`);
  }

  for (let ii = 0; ii < this.deps.length; ++ii) {
    let dep_name = this.deps[ii];
    assert(typeof dep_name === 'string',
      `Task "${this.name}": entries in "deps" must be strings, found ${typeof dep_name}`);
  }

  let taskdir = path.join(gb.config.statedir, 'tasks', this.name);
  this.task_state = createTaskState({ dir: taskdir, name: this.name });
  if (this.target) {
    let targetdir = gb.config.targets[this.target];
    assert(targetdir,
      `Task "${this.name}": "target" must be empty or reference a target specified in configure(),` +
      ` found "${this.target}"`);
    this.outdir = targetdir;
    this.bucket_out = this.target;
  } else {
    this.outdir = path.join(taskdir, 'out');
    this.bucket_out = this.name;
  }
}

BuildTask.prototype.reset = function () {
  this.active = false; // depended on by an a active task
  this.status = STATUS_PENDING;
  this.last_time = Date.now();
  this.err = null;
};

GlovBuild.prototype.configure = function (opts) {
  assert(opts);
  this.config = merge(this.config, opts);
  // Replace target paths with canonical forward slashes
  for (let key in this.config.targets) {
    this.config.targets[key] = forwardSlashes(this.config.targets[key]);
  }
  this.resetFiles();
};

GlovBuild.prototype.resetFiles = function () {
  this.files = filesCreate(this);
  this.files.addBucket('source', this.config.source);
  for (let key in this.config.targets) {
    assert(!this.files.getBucketDir(key), `Target "${key}": must not be a reserved name`);
    this.files.addBucket(key, this.config.targets[key]);
  }
  for (let key in this.tasks) { // only upon reset during testing
    let task = this.tasks[key];
    this.files.addBucket(task.name, task.outdir);
  }
};

GlovBuild.prototype.task = function (task) {
  task = new BuildTask(this, task);
  assert(!this.tasks[task.name], `Task "${task.name}": task already declared`);
  assert(!this.config.targets[task.name], `Task "${task.name}": must not be named the same as a target`);
  assert(!this.files.getBucketDir(task.name), `Task "${task.name}": must not be a reserved name`);
  this.files.addBucket(task.name, task.outdir);

  // Validate inter-task dependencies
  // convert dep names to dep references
  // determine the dependency depth ("phase", just for UI?)
  let max_phase = 0;
  for (let ii = 0; ii < task.deps.length; ++ii) {
    let dep_name = task.deps[ii];
    let dep = this.tasks[dep_name];
    assert(dep,
      `Task "${task.name}": depends on unknown task "${dep_name}"`);
    task.deps[ii] = dep;
    dep.dependors.push(task);
    max_phase = max(max_phase, dep.phase);
  }
  task.phase = max_phase + 1;

  task.deps.sort(cmpTaskPhase);

  this.tasks[task.name] = task;
};

function setActive(gb, task) {
  if (task.active) {
    return;
  }
  task.active = true;
  for (let ii = 0; ii < task.deps.length; ++ii) {
    setActive(gb, task.deps[ii]);
  }
}

function isActive(task) {
  return task.active;
}

function taskSetStatus(task, status, message) {
  let now = Date.now();
  let dt = now - task.last_time;
  task.last_time = now;
  if (status !== STATUS_PENDING && task.status !== STATUS_PENDING || status === STATUS_DONE) {
    message = `${dt}ms${message ? `, ${message}` : ''}`;
  }
  let log = `Task "${task.name}": ${task.status}->${status}${message ? ` (${message})` : ''}`;
  if (status === STATUS_PENDING || status === STATUS_PREPARING_INPUTS ||
    status === STATUS_PREPARING_DEPS
  ) {
    log = chalk.black.bold(log);
  }
  console.log(log);
  task.status = status;
}

function taskSetErr(task, err) {
  task.err = err;
  console.error(chalk.red.bold(`Task "${task.name}" error:`), err);
  taskSetStatus(task, STATUS_ERROR);
  process.exitCode = 1;
  scheduleTick(task.gb);
}

function BuildJob(gb, task, name, all_files) {
  this.gb = gb;
  this.task = task;
  this.name = name;
  this.files_all = all_files;
  this.files_updated = all_files.slice(0);
  this.files_deleted = [];
  this.need_sort = true;
  this.waiting = 1;
  this.on_done = null;
  this.done = this.done.bind(this);
  this.user_data = null;
  let deps = {}; // filename (bucket:relative) => timestamp
  for (let ii = 0; ii < all_files.length; ++ii) {
    let buildfile = all_files[ii];
    deps[buildfile.key] = buildfile.timestamp;
  }
  this.job_state = {
    deps,
    outputs: {},
  };
  this.output_queue = null;
  this.warnings = [];
  this.errors = [];
  this.last_job_state = task.task_state.getJobState(this.name);
}
BuildJob.prototype.getUserData = function () {
  if (!this.user_data) {
    this.user_data = {};
  }
  return this.user_data;
};
BuildJob.prototype.wait = function () {
  assert(this.waiting);
  ++this.waiting;
};
BuildJob.prototype.warn = function (msg) {
  assert.equal(typeof msg, 'string');
  this.warnings.push(msg);
  console.warn(chalk.yellow.bold(`  Task "${this.task.name}", Job "${this.name}": warning:`), msg);
  this.gb.stats.warnings++;
};
BuildJob.prototype.error = function (err) {
  if (!err) {
    return;
  }
  if (!(err instanceof Error)) {
    err = new Error(err);
  }
  let stack = err.stack;
  stack = stack.split('\n');
  for (let ii = 0; ii < stack.length; ++ii) {
    if (stack[ii].indexOf('glovBuildRunJobFunc') !== -1) {
      stack = stack.slice(0, ii);
    }
  }
  this.errors.push(stack[0]);
  console.error(chalk.red.bold(`  Task "${this.task.name}", Job "${this.name}": error:`),
    stack.join('\n  '));
  this.gb.stats.errors++;
};

// errors added to job.errors
function jobOutputFiles(job, cb) {
  // updates file.timestamp in BuildFiles
  let who = `${job.task.name}:${job.name}`;
  let count = 0;
  let to_prune = {};
  if (job.last_job_state) {
    for (let key in job.last_job_state.outputs) {
      to_prune[key] = true;
    }
  }
  async.eachOf(job.output_queue, function (file, key, next) {
    ++count;
    let buildkey = `${job.task.bucket_out}:${file.path}`;
    delete to_prune[buildkey];
    job.gb.files.put({
      bucket: job.task.bucket_out,
      path: file.path,
      contents: file.contents,
      who,
    }, function (err, buildfile) {
      if (err) {
        job.error(err);
      } else {
        assert(buildfile.timestamp);
        job.job_state.outputs[buildfile.key] = buildfile.timestamp;
      }
      next();
    });
  }, function () {
    // TODO: Maybe don't prune missing outputs upon error - need to keep them in
    //   the job state for pruning later, though!
    let prune_count = 0;
    async.eachOf(to_prune, function (ignored, key, next) {
      ++prune_count;
      job.gb.files.prune(...parseBucket(key), next);
    }, function () {
      cb(count, prune_count);
    });
  });
}
BuildJob.prototype.done = function (err) {
  this.error(err);
  --this.waiting;
  if (!this.waiting) {
    if (this.job_state !== this.last_job_state) {
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
        if (!any_errors) {
          this.files_updated.length = 0;
          this.files_deleted.length = 0;
        }
        // Flush job state immediately after writing all files
        // Might be slightly delayed when all jobs state are in the same file, though
        this.last_job_state = this.job_state;
        this.task.task_state.setJobState(this.name, this.job_state, (err) => {
          if (err) {
            console.error(`Internal error writing job state for ${this.task.name}:${this.name}`, err);
          }
          if (this.errors.length) {
            console.debug(`  Task "${this.task.name}", Job "${this.name}": failed`);
          } else {
            console.debug(`  Task "${this.task.name}", Job "${this.name}": complete (` +
              `${num_files} output${num_files === 1?'':'s'}`+
              `${this.warnings.length ? `, ${this.warnings.length} warning${this.warnings.length===1?'':'s'}` : ''}` +
              `${num_pruned ? `, ${num_pruned} pruned` : ''}` +
              ')');
          }
          this.on_done(err || (this.errors.length ? `${this.errors.length} error(s)` : null));
        });
      });
    } else {
      console.debug(chalk.black.bold(`  Task "${this.task.name}", Job "${this.name}": up to date`));
      assert(!this.errors.length);
      this.on_done();
    }
  }
};
function cmpFile(a, b) {
  assert(a.bucket !== b.bucket || a.path !== b.path);
  if (a.bucket < b.bucket || a.bucket === b.bucket && a.path < b.path) {
    return -1;
  }
  return 1;
}
BuildJob.prototype.sort = function () {
  if (!this.need_sort) {
    return;
  }
  this.need_sort = false;
  this.files_all.sort(cmpFile);
  this.files_updated.sort(cmpFile);
  this.files_deleted.sort(cmpFile);
};
BuildJob.prototype.getFile = function () {
  assert.equal(this.task.type, SINGLE);
  assert.equal(this.files_all.length, 1);
  return this.files_all[0];
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
BuildJob.prototype.getFilesDeleted = function () {
  this.sort();
  this.gb.stats.files_deleted += this.files_deleted.length;
  return this.files_deleted;
};
BuildJob.prototype.out = function (file) {
  // flush all files simultaneously at end of job, and immediately before flushing job state
  this.output_queue = this.output_queue || {};
  let key = `${file.bucket}:${file.path}`;
  if (this.output_queue[key]) {
    this.err = this.err || new Error(`Job is outputting the same file ("${key}") twice`);
  } else {
    this.output_queue[key] = file;
  }
};

BuildJob.prototype.depReset = function () {
  let expected_deps = {};
  for (let ii = 0; ii < this.files_all.length; ++ii) {
    expected_deps[this.files_all[ii].key] = 1;
  }
  for (let key in this.job_state.deps) {
    if (!expected_deps[key]) {
      delete this.job_state.deps[key];
      // This should only happen during run-time re-run of job that's ran in the
      //  same process, but should work fine when that's enabled.
      assert(false);
    }
  }
};

// Returns any error if not up to date
BuildJob.prototype.isUpToDate = function (cb) {
  if (!this.last_job_state) {
    return cb('no previous state');
  }
  let { gb, last_job_state, files_updated } = this;
  let { deps, outputs, warnings, errors } = last_job_state;
  if (warnings || errors) {
    console.debug(`  Task "${this.task.name}", Job "${this.name}": ` +
      `Previous run ${errors ? 'errored' : 'warned'}, re-running...`);
    return cb('previous run warned or errored');
  }
  // check that all current inputs are in the previous deps
  for (let ii = 0; ii < files_updated.length; ++ii) {
    let file = files_updated[ii];
    if (!deps[file.key]) {
      console.debug(`  Task "${this.task.name}", Job "${this.name}": "${file.key}"` +
        ' not in previous inputs, updating...');
      return cb('new input');
    }
    // timestamp equality will be checked below
  }
  async.each({ deps, outputs }, (coll, next) => {
    async.eachOfLimit(coll, ASYNC_LIMIT, (timestamp, key, next) => {
      gb.files.getStat(...parseBucket(key), `${this.task.name}:${this.name}`, (err, file) => {
        if (err) {
          console.debug(`  Task "${this.task.name}", Job "${this.name}": "${key}" missing or errored, updating...`);
          return next(err);
        }
        if (file.timestamp !== timestamp) {
          console.debug(`  Task "${this.task.name}", Job "${this.name}": "${key}" changed, updating...`);
          return next('timestamp');
        }
        next();
      });
    }, next);
  }, (err) => {
    if (!err) {
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

BuildJob.prototype.depAdd = function (name, cb) {
  // TODO: track deps
  let [bucket, relative] = parseBucket(name);
  if (bucket !== 'source') {
    // must reference a depenency of this task
    if (this.gb.config.targets[bucket]) {
      // references a target, just hope the user is not doing something invalid here!
    } else {
      assert(this.gb.tasks[bucket],
        `Job "${this.name}" in Task "${this.task.name}" references output from "${bucket}"` +
        ' which is not a declared task or target');
      assert(this.task.deps.indexOf(bucket) !== -1,
        `Job "${this.name}" in Task "${this.task.name}" references output from "${bucket}"` +
        ' which is not an explicit dependency');
    }
  }
  this.gb.files.get(bucket, relative, (err, file) => {
    if (err) {
      return cb(err);
    }
    file.is_updated = true;
    this.files_all.push(file);
    this.files_updated.push(file);
    this.need_sort = true;
    this.job_state.deps[file.key] = file.timestamp;
    cb(null, file);
  });
};

function startTask(gb, task) {
  assert.equal(task.status, STATUS_PENDING);
  if (!task.input) {
    assert(!task.func);
    taskSetStatus(task, STATUS_DONE);
    return scheduleTick(gb);
  }
  taskSetStatus(task, STATUS_PREPARING_INPUTS);

  task.task_state.loadAll(taskGatherInputs.bind(null, gb, task));
}

function taskGatherInputs(gb, task) {
  // gather inputs (just names and stat of files)
  let globs_by_bucket = {};
  for (let ii = 0; ii < task.input.length; ++ii) {
    let input = task.input[ii];
    let split = input.split(':');
    assert(split.length === 1 || split.length === 2, `Invalid glob "${input}"`);
    let bucket;
    let glob;
    if (split.length === 1) {
      bucket = 'source';
      glob = input;
    } else {
      bucket = split[0];
      glob = split[1];
    }
    globs_by_bucket[bucket] = globs_by_bucket[bucket] || [];
    globs_by_bucket[bucket].push(glob);
  }
  async.mapValuesSeries(globs_by_bucket, function (globs, bucket, next) {
    if (bucket === 'source') {
      // Raw from filesystem
      fg(globs, {
        cwd: gb.files.getBucketDir(bucket),
        objectMode: true,
      }, function (err, entries) {
        if (err) {
          return next(err);
        }
        async.mapLimit(entries, ASYNC_LIMIT, function (file, next) {
          gb.files.getStat(bucket, file.path, task.name, function (err, buildfile) {
            if (err) {
              return next(err);
            }
            buildfile.is_updated = true;
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
      let mapped = gb.files.glob(bucket, globs);
      // TODO: Ned to call gb.files.get on each to actually load the data?
      next(null, Object.values(mapped));
    }
  }, function (err, files_by_bucket) {
    if (err) {
      return taskSetErr(task, err);
    }
    let files = [];
    for (let key in files_by_bucket) {
      files = files.concat(files_by_bucket[key]);
    }
    taskGatherDeps(gb, task, files);
  });
}

function taskGatherDeps(gb, task, input_files) {
  assert.equal(task.status, STATUS_PREPARING_INPUTS);
  taskSetStatus(task, STATUS_PREPARING_DEPS);
  // gather timestamps of deps and outputs to check what jobs are valid
  // This is not strictly needed as a separate phase, but helps with managing
  // stages/phases so that all async dep querying will be done before a single
  // user-level function is ran?
  let job_states = task.task_state.getAllJobStates();
  let waiting = 1;
  function done() {
    --waiting;
    if (!waiting) {
      executeTask(gb, task, input_files);
    }
  }
  let queried = {};
  function statFile(filename) {
    if (queried[filename]) {
      return;
    }
    queried[filename] = true;
    ++waiting;
    gb.files.getStat(...parseBucket(filename), task.name, done);
  }
  function pruneFile(filename) {
    ++waiting;
    gb.files.prune(...parseBucket(filename), done);
  }

  // prune jobs that are no longer valid
  if (task.type === SINGLE) {
    let valid_keys = {};
    for (let ii = 0; ii < input_files.length; ++ii) {
      valid_keys[input_files[ii].key] = true;
    }
    for (let job_name in job_states) {
      if (!valid_keys[job_name]) {
        console.debug(`  Task "${task.name}", Job "${job_name}": not in new input, pruning...`);
        let job_state = job_states[job_name];
        ++waiting;
        task.task_state.setJobState(job_name, null, done);
        for (let key in job_state.outputs) {
          pruneFile(key);
        }
      }
    }
  }

  for (let job_name in job_states) {
    let job_state = job_states[job_name];
    for (let key in job_state.deps) {
      statFile(key);
    }
    for (let key in job_state.outputs) {
      statFile(key);
    }
  }
  done();
}

function executeTask(gb, task, inputs) {
  assert.equal(task.status, STATUS_PREPARING_DEPS);
  let jobs = [];
  if (task.type === SINGLE) {
    // make a job for each input
    for (let ii = 0; ii < inputs.length; ++ii) {
      jobs.push(new BuildJob(gb, task, inputs[ii].key, [inputs[ii]]));
    }
  } else if (task.type === ALL) {
    // make a single job
    jobs.push(new BuildJob(gb, task, 'all', inputs));
  }
  taskSetStatus(task, STATUS_RUNNING, `${jobs.length} jobs`);
  // TODO: add this to a global job queue for rate limiting?
  // TODO: async.eachLimit doesn't gracefully handle an error - other jobs keep
  //   running and callback is called before they finish?
  async.eachLimit(jobs, ASYNC_LIMIT, function (job, next) {
    job.on_done = next;
    executeJob(gb, task, job);
  }, function (err) {
    if (err) {
      return taskSetErr(task, err);
    }
    taskSetStatus(task, STATUS_DONE);
    scheduleTick(gb);
  });
}

function executeJob(gb, task, job) {
  // Should have at least the names and stat on all input files
  // Check deps and outputs and decide if this can be skipped
  job.isUpToDate(function (err) {
    if (!err) {
      // already up to date
      return job.done();
    }
    async.eachLimit(job.files_updated, ASYNC_LIMIT, function (buildfile, next) {
      buildfile.get(next);
    }, function glovBuildRunJobFunc(err) {
      if (err) {
        return job.done(err);
      }
      gb.stats.jobs++;
      task.func(job, job.done.bind(job));
    });
  });
}

function tick(gb) {
  gb.tick_scheduled = false;
  let { tasks } = gb;
  let all_tasks_done = true;
  let any_change = false;
  let any_errored = false;
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (!task.active) {
      continue;
    }
    if (task.status === STATUS_ERROR || task.status === STATUS_ABORTED) {
      any_errored = true;
    } else if (task.status !== STATUS_DONE) {
      all_tasks_done = false;
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
      }
      if (dep.status !== STATUS_DONE) {
        all_deps_done = false;
      }
    }
    if (dep_errored) {
      taskSetStatus(task, STATUS_ABORTED);
      any_change = true;
      continue;
    }
    if (!all_deps_done) {
      continue;
    }
    startTask(gb, task);
  }
  if (!gb.was_all_done && all_tasks_done) {
    gb.emit('done', any_errored ? 'At least one task has errored' : undefined);
  }
  gb.was_all_done = all_tasks_done;
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
  console.log('Performing clean...');
  async.series([
    function cleanJobs(next) {
      async.eachSeries(gb.tasks, function (task, next) {
        task.task_state.loadAll(function () {
          let job_states = task.task_state.getAllJobStates();
          async.eachOfLimit(job_states, 1, function (job_state, job_name, next) {
            let { outputs } = job_state;
            if (empty(outputs)) {
              // just clear job state
              return task.task_state.setJobState(job_name, null, next);
            }
            async.eachOfLimit(outputs, 1, function (ignored, key, next) {
              gb.files.prune(...parseBucket(key), function (err) {
                if (err) {
                  console.error('Error deleting file:', err);
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
      async.eachOfLimit(gb.config.targets, 1, function (target_dir, target_name, next) {
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
            async.eachLimit(files, 1, function (filename, next) {
              console.log(`  Deleting ${filename}...`);
              deleteFileWithRmdir(filename, next);
            }, next);
          } else {
            console.warn(chalk.yellow.bold('Warning: Unexpected files found in output target ' +
              `"${target_name}" (${target_dir}):`));
            for (let ii = 0; ii < files.length; ++ii) {
              console.log(`  ${forwardSlashes(path.relative(target_dir, files[ii]))}`);
            }
            console.log('Run with --force to remove');
            next();
          }
        });
      }, next);
    },
  ], function (err) {
    if (err) {
      console.error('Error performing clean:', err);
    } else {
      scheduleTick(gb);
    }
  });
}


GlovBuild.prototype.go = function (opts) {
  opts = opts || {};
  if (typeof opts === 'string') {
    opts = { tasks: [opts] };
  } else if (Array.isArray(opts)) {
    opts = { tasks: opts };
  }

  // TODO: check no overlap between any of files.bucket_dirs (fully resolved) paths

  const argv = this.argv = minimist(opts.argv || process.argv.slice(2));
  let dry_run = argv.n || argv['dry-run'] || opts.dry_run;

  // Flag all tasks as active that we want to be running in this session
  if (!opts.tasks) {
    opts.tasks = argv._ || [];
  }
  if (!opts.tasks.length) {
    opts.tasks.push('default');
  }
  assert(opts.tasks.length);
  let { tasks } = this;
  let need_clean = false;
  for (let ii = 0; ii < opts.tasks.length; ++ii) {
    let task_name = opts.tasks[ii];
    let task = tasks[task_name];
    if (!task && task_name === 'clean') {
      need_clean = true;
    } else {
      assert(task, `Unknown task "${task_name}"`);
      setActive(this, task);
    }
  }

  // Display status
  console.log('Task Tree');
  console.log('=========');
  dumpDepTree(this);
  console.log('');
  if (dry_run) {
    return;
  }

  // Prune inactive tasks
  for (let task_name in tasks) {
    let task = tasks[task_name];
    task.dependors_active = task.dependors.filter(isActive);
  }

  // All tasks should be flagged as pending
  if (need_clean) {
    doClean(this);
  } else {
    scheduleTick(this);
  }
  return this;
};

GlovBuild.prototype.stop = function () {
  for (let key in this.tasks) {
    this.tasks[key].reset();
  }
  this.reset();
  this.resetFiles();
};

function create() {
  return new GlovBuild();
}
exports.create = create;
