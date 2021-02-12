const assert = require('assert');
const { floor, max } = Math;
const minimist = require('minimist');
const { merge } = require('./util.js');

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
    dep.dependors = dep.dependors || [];
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
          if (printed[name]) {
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
    console.log(line);
  }
}

GlovBuild.prototype.go = function (opts) {
  opts = opts || {};
  if (typeof opts === 'string') {
    opts = { tasks: [opts] };
  }

  // Flag all tasks as active that we want to be running in this session
  const argv = minimist(opts.argv || process.argv.slice(2));
  if (!opts.tasks) {
    opts.tasks = argv._ || [];
  }
  if (!opts.tasks.length) {
    opts.tasks.push('default');
  }
  assert(opts.tasks.length);
  for (let ii = 0; ii < opts.tasks.length; ++ii) {
    let task_name = opts.tasks[ii];
    let task = this.tasks[task_name];
    assert(task, `Unknown task "${task_name}"`);
    setActive(this, task);
  }
  if (argv.deps) {
    console.log('Dependency Tree');
    console.log('===============');
    dumpDepTree(this);
    return;
  }
  // Prune inactive tasks
  for (let task_name in this.tasks) {
    let task = this.tasks[task_name];
    if (!task.active) {
      delete this.tasks[task_name];
    } else {
      task.dependors = task.dependors.filter(isActive);
    }
  }
};

function create() {
  return new GlovBuild();
}
exports.create = create;
