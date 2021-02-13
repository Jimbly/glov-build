exports.dumpDepTree = dumpDepTree;

const { floor, max } = Math;
const { cmpTaskPhase } = require('./util.js');

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
