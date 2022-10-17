GLOV.js Build System
====================

API Stability: MEDIUM-HIGH - No longer under active development, used in multiple production projects

A build system tailored for JavaScript game development, focused on fast, incremental builds with live updates of assets in many shapes and sizes.  Created primarily for large projects built on [GLOV.js](https://github.com/Jimbly/glovjs) in order to address the many shortcomings of other options that exhibit themselves as a project grows in size.

### Overview

# Tasks
A task represents a stage in the build pipeline, and define the inputs and how jobs are run on those inputs (either per-input or on all inputs at once).  Specifically, a task usually defines an input glob and a job function to run on those files.

# Jobs
A job is a single operation on an input or set of inputs. Individual jobs are only ran if one of their dependencies have changed, and their outputs only trigger dependent tasks to run if the output actually changes.

### Simple example
```javascript
const gb = require('glov-build');

gb.configure({
  source: 'src',
  statedir: 'out/.gbstate',
  targets: {
    dev: 'out',
  },
});

gb.task({
  name: 'copy',
  input: 'txt/*.txt',
  type: gb.SINGLE, // Type SINGLE - `func` is called once per changed input file
  target: 'dev',
  func: function copy(job, done) {
    job.out(job.getFile());
    done();
  },
});

gb.task({
  name: 'concat',
  input: [
    'txt/*.txt',
    'txt/*.asc',
  ],
  type: gb.ALL, // Type ALL - `func` is called once with all input files
  target: 'dev',
  func: function concatSimple(job, done) {
    let files = job.getFiles();
    let buffer = Buffer.concat(files.filter(a => a.contents).map(a => a.contents));
    job.out({
      relative: 'concat.txt',
      contents: buffer,
    });
    done();
  },
});

gb.task({
  name: 'default',
  deps: ['copy', 'concat'],
});

gb.go({
  tasks: ['default'],
  watch: true,
});

```


### More Complex Examples
* A bunch of arbitrary testing examples in [test/tests/test_tasks.js](https://github.com/Jimbly/glovjs-build/blob/master/test/tests/test_tasks.js) in this repo
* A complex real world build system in [the actual build script for GLOV.js projects](https://github.com/Jimbly/glovjs/tree/master/build)
* [Wrapping GULP tasks](https://github.com/Jimbly/glovjs/blob/master/build/gulpish-tasks.js)
