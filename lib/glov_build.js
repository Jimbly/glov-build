const assert = require('assert');
const async = require('async');
const { dumpDepTree } = require('./debug.js');
const fast_glob = require('fast-glob');
const { filesCreate } = require('./files.js');
const { max } = Math;
const minimist = require('minimist');
const path = require('path');
const { callbackify, cmpTaskPhase, merge } = require('./util.js');

const fg = callbackify(fast_glob);

// general path mapping (all via files.buckets)
//   foo/bar.baz -> config.source
//   taskname:foo/bar.baz -> task.outdir
//   targetname:foo/bar.baz -> config.targets[targetname]

const STATUS_PENDING = 'pending';
const STATUS_PREPARING = 'preparing';
const STATUS_RUNNING = 'running';
const STATUS_DONE = 'done';
const STATUS_ERROR = 'error';

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
}
GlovBuild.prototype.ALL = ALL;
GlovBuild.prototype.SINGLE = SINGLE;

const invalid_file_char = /[/\\'"`$%:]/;

let last_task_uid=0;
function BuildTask(gb, opts) {
  this.gb = gb;
  // Run-time state
  this.active = false; // depended on by an a active task
  this.phase = 0; // for the UI, where it fits horizontally; how deep is the dep tree to us
  this.uid = ++last_task_uid;
  this.dependors = [];
  this.status = STATUS_PENDING;
  this.err = null;
  this.taskdir = null; // location for task state tracking
  this.outdir = null; // location for output files, may be the same as taskdir or may be a (shared) target

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
      `Task "${this.name}": "type" must be gb.SINGLE, gb.ALL, or gb.UTILITY, found ${this.type}`);

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

  this.taskdir = path.join(gb.config.statedir, 'tasks', this.name);
  if (this.target) {
    let targetdir = gb.config.targets[this.target];
    assert(targetdir,
      `Task "${this.name}": "target" must be empty or reference a target specified in configure(),` +
      ` found "${this.target}"`);
    this.outdir = targetdir;
    this.bucket_out = this.target;
  } else {
    this.outdir = this.taskdir;
    this.bucket_out = this.name;
  }
}

GlovBuild.prototype.configure = function (opts) {
  assert(opts);
  this.config = merge(this.config, opts);
  this.files = filesCreate(this);
  this.files.addBucket('source', this.config.source);
  for (let key in this.config.targets) {
    assert(!this.files.buckets[key], `Target "${key}": must not be a reserved name`);
    this.files.addBucket(key, this.config.targets[key]);
  }
};

GlovBuild.prototype.task = function (task) {
  task = new BuildTask(this, task);
  assert(!this.tasks[task.name], `Task "${task.name}": task already declared`);
  assert(!this.config.targets[task.name], `Task "${task.name}": must not be named the same as a target`);
  assert(!this.files.buckets[task.name], `Task "${task.name}": must not be a reserved name`);
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

function taskSetStatus(task, status) {
  console.log(`Task "${task.name}": ${task.status}->${status}`);
  task.status = status;
}

function taskSetErr(task, err) {
  task.err = err;
  console.error(`Task "${task.name}" error:`, err);
  taskSetStatus(task, STATUS_ERROR);
}

function BuildJob(gb, task, all_files) {
  this.gb = gb;
  this.task = task;
  this.files_all = all_files;
  this.files_updated = all_files.slice(0);
  this.files_deleted = [];
  this.waiting = 1;
  this.err = null;
  this.on_done = null;
  this.done = this.done.bind(this);
  this.user_data = null;
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
BuildJob.prototype.done = function (err) {
  this.err = this.err || err;
  --this.waiting;
  if (!this.waiting) {
    this.on_done(this.err);
  }
};
BuildJob.prototype.getFile = function () {
  assert.equal(this.task.type, SINGLE);
  assert.equal(this.files_all.length, 1);
  return this.files_all[0];
};
BuildJob.prototype.getFiles = function () {
  return this.files_all;
};
BuildJob.prototype.getFilesUpdated = function () {
  return this.files_updated;
};
BuildJob.prototype.getFilesDeleted = function () {
  return this.files_deleted;
};
BuildJob.prototype.out = function (file) {
  this.wait();
  file = this.gb.files.newFile({
    bucket: this.task.bucket_out,
    path: file.path,
    contents: file.contents,
  });
  this.gb.files.put(file, this.done);
};

BuildJob.prototype.depReset = function () {
  // TODO: track deps
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
  this.gb.files.get(bucket, relative, (err, file) => {
    if (err) {
      return cb(err);
    }
    file.is_updated = true;
    this.files_all.push(file);
    this.files_updated.push(file);
    cb(null, file);
  });
};

function executeTask(gb, task, inputs) {
  assert.equal(task.status, STATUS_PREPARING);
  taskSetStatus(task, STATUS_RUNNING);
  let jobs = [];
  if (task.type === SINGLE) {
    // make a job for each input
    for (let ii = 0; ii < inputs.length; ++ii) {
      jobs.push(new BuildJob(gb, task, [inputs[ii]]));
    }
  } else if (task.type === ALL) {
    // make a single job
    jobs.push(new BuildJob(gb, task, inputs));
  }
  // TODO: add this to a global job queue for rate limiting?
  // TODO: async.eachLimit doesn't gracefully handle an error - other jobs keep
  //   running and callback is called before they finish?
  async.eachLimit(jobs, ASYNC_LIMIT, function (job, next) {
    job.on_done = next;
    task.func(job, job.done.bind(job));
  }, function (err) {
    if (err) {
      return taskSetErr(task, err);
    }
    taskSetStatus(task, STATUS_DONE);
    scheduleTick(gb); // eslint-disable-line no-use-before-define
  });
}

function startTask(gb, task) {
  assert.equal(task.status, STATUS_PENDING);
  taskSetStatus(task, STATUS_PREPARING);
  // gather inputs
  let fs_globs = [];
  for (let ii = 0; ii < task.input.length; ++ii) {
    let input = task.input[ii];
    if (input.indexOf(':') === -1) {
      fs_globs.push(input);
    } else {
      assert(false, 'TODO: intermediate inputs');
    }
  }
  let source_bucket = 'source';
  fg(fs_globs, {
    cwd: gb.config.source,
    objectMode: true,
  }, function (err, entries) {
    if (err) {
      return taskSetErr(task, err);
    }
    async.mapLimit(entries, ASYNC_LIMIT, function (file, next) {
      gb.files.get(source_bucket, file.path, function (err, buildfile) {
        if (err) {
          return next(err);
        }
        buildfile.is_updated = true;
        return next(null, buildfile);
      });
    }, function (err, mapped) {
      if (err) {
        return taskSetErr(task, err);
      }
      executeTask(gb, task, mapped);
    });
  });
}

function tick(gb) {
  gb.tick_scheduled = false;
  let { tasks } = gb;
  for (let task_name in tasks) {
    let task = tasks[task_name];
    if (task.status !== STATUS_PENDING) {
      continue;
    }
    let all_deps_done = true;
    for (let ii = 0; ii < task.deps.length; ++ii) {
      let dep = task.deps[ii];
      if (dep.status !== STATUS_DONE) {
        all_deps_done = false;
        break;
      }
    }
    if (!all_deps_done) {
      continue;
    }
    startTask(gb, task);
  }
}

function scheduleTick(gb) {
  if (gb.tick_scheduled) {
    return;
  }
  gb.tick_scheduled = true;
  process.nextTick(tick.bind(null, gb));
}


GlovBuild.prototype.go = function (opts) {
  opts = opts || {};
  if (typeof opts === 'string') {
    opts = { tasks: [opts] };
  } else if (Array.isArray(opts)) {
    opts = { tasks: opts };
  }

  // TODO: check no overlap between any of files.buckets (fully resolved) paths

  const argv = minimist(opts.argv || process.argv.slice(2));
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
  for (let ii = 0; ii < opts.tasks.length; ++ii) {
    let task_name = opts.tasks[ii];
    let task = tasks[task_name];
    assert(task, `Unknown task "${task_name}"`);
    setActive(this, task);
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
    if (!task.active) {
      delete tasks[task_name];
    } else {
      task.dependors = task.dependors.filter(isActive);
    }
  }

  // All tasks should already be flagged as pending
  // TODO: first load outputs and deps and evaluate this intelligently

  tick(this);
};

function create() {
  return new GlovBuild();
}
exports.create = create;
