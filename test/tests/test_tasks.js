const assert = require('assert');
const { asyncEach } = require('glov-async');
// const gb = require('glov-build');
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

let atlas_last_reset;
exports.atlasLastReset = function () {
  assert(atlas_last_reset);
};
exports.atlasLastNotReset = function () {
  assert(!atlas_last_reset);
};

let did_run;
exports.didRun = function didRun() {
  assert(did_run);
  did_run = false;
};

function configure(params) {
  gb.configure({
    source: WORK_DIR,
    statedir: STATE_DIR,
    targets,
    log_level: gb.LOG_SILLY,
    ...(params || {}),
  });
}
exports.configure = configure;

exports.registerTasks = function () {
  configure();

  function copy(job, done) {
    job.out(job.getFile());
    done();
  }

  function copyToRoot(job, done) {
    let file = job.getFile();
    job.out({
      relative: path.basename(file.relative),
      contents: file.contents,
    });
    done();
  }

  function copyAll2(job, done) {
    let files = job.getFiles();
    if (files.length !== 2) {
      return done('Expected 2 files');
    }
    for (let ii = 0; ii < files.length; ++ii) {
      job.out(files[ii]);
    }
    done();
  }

  function copyTo(dest) {
    return function (job, done) {
      let file = job.getFile();
      job.out({
        relative: `${dest}/${file.relative}`,
        contents: file.contents,
      });
      done();
    };
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
      relative: file.relative,
      contents: buffer,
    });
    done();
  }

  function toContents(f) {
    return f.contents;
  }

  function concatSimple(opts) {
    return function (job, done) {
      let files = job.getFiles();
      let buffer = Buffer.concat(files.filter(toContents).map(toContents));
      job.out({
        relative: opts.output,
        contents: buffer,
      });
      done();
    };
  }

  function cmpName(a, b) {
    return a.relative < b.relative ? -1 : 1;
  }

  function concatCachedInternal(opts, job, done) {
    let updated_files = job.getFilesUpdated();
    let user_data = job.getUserData();
    user_data.files = user_data.files || {};

    for (let ii = 0; ii < updated_files.length; ++ii) {
      let f = updated_files[ii];
      if (opts.skip === f.relative) {
        continue;
      }
      if (!f.contents) {
        delete user_data.files[f.relative];
      } else {
        user_data.files[f.relative] = f;
      }
    }
    let files = Object.values(user_data.files).sort(cmpName);

    // Note: above is equivalent to `let files = job.getFiles()`, since we're not actually caching anything

    let buffer = Buffer.concat(files.map(toContents));
    job.out({
      relative: opts.output,
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
      user_data.files = user_data.files || {};

      for (let ii = 0; ii < updated_files.length; ++ii) {
        let f = updated_files[ii];
        if (f === input) {
          continue;
        }
        if (!f.contents) {
          if (f.relative.indexOf('expected_missing') === -1) {
            job.error(`Missing source file ${f.relative}: ${f.err}`);
          }
          delete user_data.files[f.relative];
          continue;
        }
        if (f.contents.toString().indexOf('warn') !== -1) {
          job.warn(f, `Warning on ${f.relative}`);
        }
        if (f.contents.toString().indexOf('error') !== -1) {
          job.error(f, `Error on ${f.relative}`);
        }
        user_data.files[f.relative] = f;
      }
      let files = Object.values(user_data.files).sort(cmpName);

      let buffer = Buffer.concat(files.map(toContents));
      job.out({
        relative: input_data.output,
        contents: buffer,
      });
      done();
    }

    if (job.isFileUpdated(input)) {
      atlas_last_reset = true;
      job.log('Doing reset');
      job.depReset();

      try {
        input_data = JSON.parse(input.contents);
      } catch (e) {
        return done(`Error parsing ${input.relative}: ${e}`);
      }

      let { output, inputs } = input_data;
      if (!output) {
        return done('Missing `output` field');
      }
      if (!inputs || !inputs.length) {
        return done('Missing or empty `inputs` field');
      }
      user_data.atlas_data = input_data;

      asyncEach(inputs, (name, next) => {
        job.depAdd(name, function (/*err, f*/) {
          // Not doing this here, will error generically in doAtlas
          // if (err) {
          //   job.error(f, `Missing source file ${name}: ${err}`);
          // }
          next();
        });
      }, doAtlas);
    } else {
      atlas_last_reset = false;
      job.log('Doing incremental update');
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
      return done(`Error parsing ${input.relative}: ${e}`);
    }

    let { outputs } = input_data;
    if (!outputs) {
      return done('Missing `output` field');
    }

    for (let key in outputs) {
      job.out({
        relative: key,
        contents: outputs[key],
      });
    }
    done();
  }

  function warnOn(file) {
    return function (job, done) {
      if (job.getFile().relative === file) {
        job.warn(`(expected warning on ${file})`);
      }
      done();
    };
  }

  function errorOn(file) {
    return function (job, done) {
      if (job.getFile().relative === file) {
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
    name: 'copy_to_root',
    input: '**.txt',
    type: gb.SINGLE,
    target: 'dev',
    func: copyToRoot,
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
    name: 'copy_to_int',
    input: 'txt/*.txt',
    type: gb.ALL,
    func: copyAll2,
  });
  gb.task({
    name: 'atlas_from_copy',
    input: 'atlas/*.json',
    type: gb.SINGLE,
    target: 'dev',
    deps: ['copy_to_int'],
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

  did_run = false;
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

  function copySlow(job, done) {
    setTimeout(() => {
      job.out(job.getFile());
      done();
    }, 250);
  }
  gb.task({
    name: 'slow_copy',
    input: 'txt/*.txt',
    type: gb.SINGLE,
    func: copySlow,
  });
  gb.task({
    name: 'slow_copy_post',
    input: 'slow_copy:**',
    type: gb.SINGLE,
    func: copySlow,
    target: 'dev',
  });


  gb.task({
    name: 'output_filename',
    input: '**',
    type: gb.SINGLE,
    version: Date.now(), // Resetting task version each serial run
    func: function (job, done) {
      let file = job.getFile();
      job.out({
        relative: file.relative,
        contents: file.relative,
      });
      done();
    },
  });
  gb.task({
    name: 'copy_unchanged',
    input: 'output_filename:**',
    target: 'dev',
    type: gb.SINGLE,
    func: copy,
  });

  gb.task({
    name: 'simple1dev',
    input: 'file1',
    target: 'dev',
    type: gb.SINGLE,
    func: copy,
  });
  gb.task({
    name: 'simple2dev',
    input: 'file2',
    target: 'dev',
    type: gb.SINGLE,
    func: copy,
  });
  gb.task({
    name: 'metadev',
    deps: ['simple1dev', 'simple2dev'],
  });
  gb.task({
    name: 'from_metadev',
    input: 'metadev:**',
    target: 'dev',
    type: gb.SINGLE,
    func: copyTo('meta'),
  });

  gb.task({
    name: 'simple1',
    input: 'file1',
    type: gb.SINGLE,
    func: copy,
  });
  gb.task({
    name: 'simple2',
    input: 'file2',
    type: gb.SINGLE,
    func: copy,
  });
  gb.task({
    name: 'meta',
    deps: ['simple1', 'simple2'],
  });
  gb.task({
    name: 'from_meta',
    input: 'meta:**',
    target: 'dev',
    type: gb.SINGLE,
    func: copy,
  });

  gb.task({
    name: 'execish',
    input: 'copy:**',
    type: gb.ALL,
    func: function (job, done) {
      did_run = true;
      job.log('Execish running!');
      done();
    },
  });

  gb.task({
    name: 'execish2',
    input: 'copy:**',
    type: gb.ALL,
    read: false,
    version: Date.now(), // Force it to always run
    func: function (job, done) {
      did_run = true;
      job.log('Execish running!');
      done();
    },
  });

  gb.task({
    name: 'default',
    deps: ['concat', 'copy', 'concat-reverse', 'atlas', 'never_runs', 'does_run'],
  });

  gb.task({
    name: 'reduced',
    deps: ['concat', 'copy', 'concat-reverse', 'atlas'],
  });
};
