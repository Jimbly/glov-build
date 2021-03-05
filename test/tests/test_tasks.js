const assert = require('assert');
const async = require('async');
// const gb = require('glovjs-build');
const gb = require('../../');
const path = require('path');

const targets = {
  dev: path.join(__dirname, '../out/test1/dev'),
};
exports.targets = targets;

const WORK_DIR = path.join(__dirname, '../work');
exports.WORK_DIR = WORK_DIR;
const STATE_DIR = path.join(__dirname, '../out/test1/.gbstate');
exports.STATE_DIR = STATE_DIR;

gb.configure({
  source: WORK_DIR,
  statedir: STATE_DIR,
  targets,
});

function copy(job, done) {
  job.out(job.getFile());
  done();
}

function reverse(job, done) {
  let file = job.getFile();
  let buffer = Buffer.from(file.contents);
  for (let ii = 0; ii < buffer.length / 2; ++ii) {
    let t = buffer[ii];
    buffer[ii] = buffer[buffer.length - 1 - ii];
    buffer[buffer.length - 1 - ii] = t;
  }
  job.out({
    path: file.path,
    contents: buffer,
  });
  done();
}

function concatSimple(opts) {
  return function (job, done) {
    let files = job.getFiles();
    let buffer = Buffer.concat(files.map((f) => f.contents));
    job.out({
      path: opts.output,
      contents: buffer,
    });
    done();
  };
}

function cmpName(a, b) {
  return a.path < b.path ? -1 : 1;
}

function concatCachedInternal(opts, job, done) {
  let updated_files = job.getFilesUpdated();
  let deleted_files = job.getFilesDeleted();
  let user_data = job.getUserData();
  user_data.files = user_data.files || {};
  for (let ii = 0; ii < deleted_files.length; ++ii) {
    delete user_data.files[deleted_files[ii].path];
  }

  for (let ii = 0; ii < updated_files.length; ++ii) {
    let f = updated_files[ii];
    if (opts.skip === f.path) {
      continue;
    }
    user_data.files[f.path] = f;
  }
  let files = Object.values(user_data.files).sort(cmpName);

  // Note: above is equivalent to `let files = job.getFiles()`, since we're not actually caching anything

  let buffer = Buffer.concat(files.map((f) => f.contents));
  job.out({
    path: opts.output,
    contents: buffer,
  });
  done();
}

function concatCached(opts) {
  return concatCachedInternal.bind(null, opts);
}

function atlas(job, done) {
  let input = job.getFile();
  let user_data = job.getUserData();
  let input_data;

  function doAtlas() {
    let updated_files = job.getFilesUpdated();
    let deleted_files = job.getFilesDeleted();
    user_data.files = user_data.files || {};
    for (let ii = 0; ii < deleted_files.length; ++ii) {
      delete user_data.files[deleted_files[ii].path];
    }

    for (let ii = 0; ii < updated_files.length; ++ii) {
      let f = updated_files[ii];
      if (f === input) {
        continue;
      }
      if (f.contents.toString().indexOf('warn') !== -1) {
        job.warn(`Warning on ${f.path}`);
      }
      if (f.contents.toString().indexOf('error') !== -1) {
        job.error(`Error on ${f.path}`);
      }
      user_data.files[f.path] = f;
    }
    let files = Object.values(user_data.files).sort(cmpName);

    let buffer = Buffer.concat(files.map((f) => f.contents));
    job.out({
      path: input_data.output,
      contents: buffer,
    });
    done();
  }

  if (input.isUpdated()) {
    job.depReset();

    try {
      input_data = JSON.parse(input.contents);
    } catch (e) {
      return done(`Error parsing ${input.path}: ${e}`);
    }

    let { output, inputs } = input_data;
    if (!output) {
      return done('Missing `output` field');
    }
    if (!inputs || !inputs.length) {
      return done('Missing or empty `inputs` field');
    }
    user_data.atlas_data = input_data;

    async.each(inputs, (name, next) => {
      job.depAdd(name, next);
    }, (err) => {
      if (err) {
        return done(err);
      }
      doAtlas();
    });
  } else {
    // only a dep has changed
    input_data = user_data.atlas_data;

    // input did not change, no changes to which files we depend on
    doAtlas();
  }
}

function multiout(job, done) {
  let input = job.getFile();
  let input_data;
  try {
    input_data = JSON.parse(input.contents);
  } catch (e) {
    return done(`Error parsing ${input.path}: ${e}`);
  }

  let { outputs } = input_data;
  if (!outputs) {
    return done('Missing `output` field');
  }

  for (let key in outputs) {
    job.out({
      path: key,
      contents: outputs[key],
    });
  }
  done();
}

function warnOn(file) {
  return function (job, done) {
    if (job.getFile().path === file) {
      job.warn(`(expected warning on ${file})`);
    }
    done();
  };
}

function errorOn(file) {
  return function (job, done) {
    if (job.getFile().path === file) {
      // done(err) should also do the same
      job.error(`(expected error on ${file})`);
    }
    done();
  };
}

gb.task({
  name: 'copy',
  input: 'txt/*.txt',
  type: gb.SINGLE,
  target: 'dev',
  func: copy,
});

gb.task({
  name: 'concat',
  input: [
    'txt/*.txt',
    'txt/*.asc',
  ],
  type: gb.ALL,
  target: 'dev',
  func: concatSimple({ output: 'concat.txt' }),
});

gb.task({
  name: 'reverse',
  input: 'txt/*.txt',
  type: gb.SINGLE,
  func: reverse,
});

gb.task({
  name: 'concat-reverse',
  input: 'reverse:**',
  type: gb.ALL,
  target: 'dev',
  func: concatCached({ output: 'concat-reverse.txt' }),
});

gb.task({
  name: 'atlas',
  input: 'atlas/*.json',
  type: gb.SINGLE,
  target: 'dev',
  func: atlas,
});

gb.task({
  name: 'multiout',
  input: 'multi/*.json',
  type: gb.SINGLE,
  target: 'dev',
  func: multiout,
});

gb.task({
  name: 'warns',
  input: 'txt/*.txt',
  type: gb.SINGLE,
  func: warnOn('txt/file2.txt'),
});

let did_run = false;
exports.didRun = function didRun() {
  assert(did_run);
  did_run = false;
};
gb.task({
  name: 'does_run',
  input: 'txt/*.txt',
  type: gb.ALL,
  func: (job, done) => {
    did_run = true;
    done();
  },
  deps: ['warns'],
});

gb.task({
  name: 'errors',
  input: 'txt/*.txt',
  type: gb.SINGLE,
  func: errorOn('txt/file1.txt'),
});

gb.task({
  name: 'never_runs',
  input: 'txt/*.txt',
  type: gb.SINGLE,
  func: () => assert(false),
  deps: ['errors'],
});


gb.task({
  name: 'default',
  deps: ['concat', 'copy', 'concat-reverse', 'atlas', 'never_runs', 'does_run'],
});

gb.task({
  name: 'reduced',
  deps: ['concat', 'copy', 'concat-reverse', 'atlas'],
});
