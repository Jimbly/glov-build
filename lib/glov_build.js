const assert = require('assert');
const async = require('async');
const fast_glob = require('fast-glob');
const { filesCreate } = require('./files.js');
const { floor, max } = Math;
const minimist = require('minimist');
const { callbackify, merge } = require('./util.js');

const fg = callbackify(fast_glob);

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
    targets: {},
  };
  this.tasks = {};
}
GlovBuild.prototype.ALL = ALL;
GlovBuild.prototype.SINGLE = SINGLE;

let last_task_uid=0;
function BuildTask(opts) {
  // Run-time state
  this.active = false; // depended on by an a active task
  this.phase = 0; // for the UI, where it fits horizontally; how deep is the dep tree to us
  this.uid = ++last_task_uid;
  this.dependors = [];
  this.status = STATUS_PENDING;
  this.err = null;

  // Validate and parse task options
  assert(opts);
  this.name = opts.name;
  this.deps = (opts.deps || []).slice(0);
  this.type = opts.type;
  this.input = opts.input;
  this.func = opts.func;
  this.target = opts.target;

  assert(this.name, 'Task missing required parameter "name"');
  assert(Array.isArray(this.deps),
    `Task "${this.name}": "desp" must be an Array, found ${typeof this.deps}`);

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

}

GlovBuild.prototype.configure = function (opts) {
  assert(opts);
  this.config = merge(this.config, opts);
  this.files = filesCreate(this.config);
};

function cmpTaskPhase(a, b) {
  return (b.phase - a.phase) || (a.uid - b.uid);
}

GlovBuild.prototype.task = function (task) {
  task = new BuildTask(task);
  assert(!this.tasks[task.name], `Task "${task.name}": task already declared`);

  // Validate inter-task dependencies
  if (task.target) {
    assert(this.config.targets[task.target],
      `Task "${task.name}": "target" must be empty or reference a target specified in configure(),` +
      ` found "${task.target}"`);
  }

  // convert dep names to dep references
  // determine the dependency depth
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

function Grid() {
  this.data = [];
  this.w = 0;
  this.h = 0;
}
Grid.prototype.debug = function () {
  let ret = [];
  for (let jj = 0; jj < this.h; ++jj) {
    let line = [];
    for (let ii = 0; ii < this.w; ++ii) {
      let thing = this.data[jj*this.w + ii];
      thing = thing && (thing.name || thing.conn)[0] || '.';
      line.push(thing);
    }
    ret.push(line.join(''));
  }
  return `${ret.join('\n')}\n`;
};
Grid.prototype.grow = function (new_w, new_h) {
  let data = new Array(new_w * new_h);
  for (let jj = 0; jj < this.h; ++jj) {
    for (let ii = 0; ii < this.w; ++ii) {
      data[ii+jj*new_w] = this.data[ii+jj*this.w];
    }
  }
  this.data = data;
  this.w = new_w;
  this.h = new_h;
  // console.log('grow', new_w, new_h);
  // console.log(this.debug());
};
Grid.prototype.set = function (x, y, thing) {
  if (x >= this.w || y >= this.h) {
    this.grow(max(this.w, x+1), max(this.h, y+1));
  }
  this.data[this.w*y + x] = thing;
  // console.log('set', x, y, thing.name || thing.conn);
  // console.log(this.debug());
};
Grid.prototype.get = function (x, y) {
  return this.data[this.w*y + x];
};
Grid.prototype.insert = function (x, y, thing) {
  // shift everything to the right
  this.grow(this.w + 1, this.h);
  for (let jj = 0; jj < this.h; ++jj) {
    for (let ii = this.w - 1; ii > x; --ii) {
      this.data[ii+jj*this.w] = this.data[ii+jj*this.w - 1];
    }
    let to_left = this.data[x-1+jj*this.w];
    let replace = null;
    if (to_left && (to_left.conn === '-' || to_left.conn === '+')) {
      replace = { conn: '-' };
    }
    this.data[x+jj*this.w] = replace;
  }
  this.data[x+y*this.w] = thing;
  // console.log('insert', x, y, thing.name || thing.conn);
  // console.log(this.debug());
};
Grid.prototype.find = function (thing) {
  let idx = this.data.indexOf(thing);
  if (idx === -1) {
    return null;
  }
  return { x: idx % this.w, y: floor(idx / this.w) };
};
function rep(char, len) {
  return new Array(len+1).join(char);
}
function pad(str, len) {
  while (str.length < len) {
    str += ' ';
  }
  return str;
}
function dumpDepTree(gb) {
  let grid = new Grid();
  let tasks = Object.values(gb.tasks);
  tasks.sort(cmpTaskPhase);
  let max_phase = tasks[0].phase;
  let inserted = {};
  function doDeps(x, y, task) {
    let only = task.deps.length === 1;
    for (let ii = 0; ii < task.deps.length; ++ii) {
      let first = ii === 0;
      let last = ii === task.deps.length - 1;
      let dep = task.deps[ii];
      grid[first ? 'set' : 'insert'](x, y+1, { conn: only ? '|' : last ? '/' : '+' });
      let dep_y = (max_phase - dep.phase) * 2;
      for (let jj = y + 2; jj < dep_y; ++jj) {
        grid.set(x, jj, { conn: '|' });
      }
      grid.set(x, dep_y, dep);
      x++;
    }
    for (let ii = 0; ii < task.deps.length; ++ii) {
      let dep = task.deps[ii];
      let pos = grid.find(dep);
      if (!inserted[dep.name]) {
        inserted[dep.name] = true;
        doDeps(pos.x, pos.y, dep);
      }
    }
  }
  tasks.forEach((task) => {
    if (inserted[task.name]) {
      return;
    }
    inserted[task.name] = true;
    let x = grid.w;
    let y = (max_phase - task.phase) * 2;
    grid.set(x, y, task);
    doDeps(x, y, task);
  });

  let column_w = [];
  for (let ii = 0; ii < grid.w; ++ii) {
    let max_w = 0;
    for (let jj = 0; jj < grid.h; ++jj) {
      let task = grid.get(ii, jj);
      if (task && task.name) {
        max_w = max(max_w, task.name.length+2);
      }
    }
    column_w.push(max_w + 1);
  }
  let printed = {};
  for (let jj = grid.h - 1; jj >= 0; --jj) {
    let line = '';
    for (let ii = 0; ii < grid.w; ++ii) {
      let w = column_w[ii];
      let elem = grid.get(ii, jj);
      if (elem) {
        if (elem.conn) {
          line += elem.conn + rep(elem.conn === '+' || elem.conn === '-' ? '-' : ' ', w-1);
        } else {
          let name = elem.name;
          if (!elem.active) {
            name = `-${name}-`;
          } else if (printed[name]) {
            // already printed, assume this is also the one that had its deps inserted?
            name = `(${name})`;
          } else {
            printed[name] = true;
          }
          line += pad(name, w);
        }
      } else {
        line += rep(' ', w);
      }
    }
    console.log(`  ${line}`);
  }
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
  this.all_files = all_files;
}
BuildJob.prototype.getFile = function () {
  assert.equal(this.task.type, SINGLE);
  assert.equal(this.all_files.length, 1);
  return this.all_files[0];
};
BuildJob.prototype.out = 'TODO';


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
  // TODO: add this to a global job queue?
  // TODO: this doesn't gracefully handle an error - other jobs keep running and callback is called before they finish?
  async.eachLimit(jobs, ASYNC_LIMIT, function (job, next) {
    task.func(job, next);
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
  fg(fs_globs, {
    cwd: gb.config.root,
    objectMode: true,
  }, function (err, entries) {
    if (err) {
      return taskSetErr(task, err);
    }
    async.mapLimit(entries, ASYNC_LIMIT, function (file, next) {
      gb.files.get(file.path, next);
    }, function (err, mapped) {
      if (err) {
        return taskSetErr(task, err);
      }
      executeTask(gb, task, mapped);
    });
  });
}

function tick(gb) {
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
  process.nextTick(tick.bind(gb));
}


GlovBuild.prototype.go = function (opts) {
  opts = opts || {};
  if (typeof opts === 'string') {
    opts = { tasks: [opts] };
  }

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
