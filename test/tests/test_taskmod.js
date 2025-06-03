// const gb = require('glov-build');
const assert = require('assert');
const gb = require('../../');
const { doTestList, multiTest } = require('./test_runner.js');
const {
  targets, STATE_DIR, WORK_DIR,
} = require('./test_tasks.js');

function copy(job, done) {
  job.out(job.getFile());
  done();
}

function configure() {
  gb.configure({
    source: WORK_DIR,
    statedir: STATE_DIR,
    targets,
    log_level: gb.LOG_SILLY,
  });
}

function registerCopyToDev() {
  configure();

  gb.task({
    name: 'copy1',
    input: 'txt/*.txt',
    type: gb.SINGLE,
    target: 'dev',
    func: copy,
  });
}

function registerTwoStep() {
  configure();

  gb.task({
    name: 'copy1',
    input: 'txt/*.txt',
    type: gb.SINGLE,
    func: copy,
  });

  gb.task({
    name: 'copy2',
    input: 'copy1:**.txt',
    type: gb.SINGLE,
    target: 'dev',
    func: copy,
  });
}

function registerJSLoadsMap() {
  configure();

  gb.task({
    name: 'copy1',
    input: '*.js',
    type: gb.SINGLE,
    target: 'dev',
    func: function (job, done) {
      let file = job.getFile();
      job.out(file);
      let mapfile = `${file.relative}.map`;
      job.depAdd(mapfile, function (err, file) {
        assert(!err);
        job.out({
          relative: mapfile,
          contents: file.contents,
        });
        done();
      });
    },
  });
}

function registerJSMapSeparate() {
  configure();

  gb.task({
    name: 'copy1',
    input: ['*.js', '*.map'],
    type: gb.SINGLE,
    target: 'dev',
    func: copy,
  });
}


let opts = { serial: true }; // no watch - cannot redefine tasks while watching!

doTestList([
  multiTest(opts, [{
    name: 'copy to intermediate',
    tasks: ['copy1'],
    register: registerTwoStep,
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      // dev: {
      //   'txt/file1.txt': 'file1',
      //   'txt/file2.txt': 'file2',
      // },
    },
    results: {
      fs_read: 2,
      fs_write: 2,
      fs_stat: 2,
      fs_delete: 0,
      jobs: 2,
    },
  }, {
    name: 'change to copy to dev',
    tasks: ['copy1'],
    register: registerCopyToDev,
    ops: {},
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      fs_read: 2,
      fs_write: 2,
      fs_stat: 2,
      fs_delete: 2,
      jobs: 2,
    },
  }]),

  multiTest(opts, [{
    name: 'copy to dev',
    tasks: ['copy1'],
    register: registerCopyToDev,
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      fs_read: 2,
      fs_write: 2,
      fs_stat: 2,
      fs_delete: 0,
      jobs: 2,
    },
  }, {
    name: 'change to copy through intermediate',
    tasks: ['copy1','copy2'],
    register: registerTwoStep,
    ops: {},
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      fs_read: 2,
      fs_write: 4,
      fs_stat: 2,
      fs_delete: 2,
      jobs: 4,
    },
  }]),

  multiTest(opts, [{
    name: 'copy to dev',
    tasks: ['copy1'],
    register: registerCopyToDev,
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      fs_read: 2,
      fs_write: 2,
      fs_stat: 2,
      fs_delete: 0,
      jobs: 2,
    },
  }, {
    name: 'change to copy to intermediate',
    tasks: ['copy1'],
    register: registerTwoStep,
    ops: {},
    outputs: {
    },
    results: {
      fs_read: 2,
      fs_write: 2,
      fs_stat: 2,
      fs_delete: 2,
      jobs: 2,
    },
  }, {
    name: 'add copy from intermediate',
    tasks: ['copy1', 'copy2'],
    register: registerTwoStep,
    ops: {},
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      fs_read: 2,
      fs_write: 2,
      fs_stat: 4,
      fs_delete: 0,
      jobs: 2,
    },
  }]),

  multiTest(opts, [{
    name: 'split from 1 source',
    tasks: ['copy1'],
    register: registerJSLoadsMap,
    ops: {
      add: {
        'index.js': 'jsfile',
        'index.js.map': 'mapfile',
      }
    },
    outputs: {
      dev: {
        'index.js': 'jsfile',
        'index.js.map': 'mapfile',
      },
    },
    results: {
      fs_read: 2,
      fs_write: 2,
      fs_stat: 2,
      fs_delete: 0,
      jobs: 1,
    },
  }, {
    name: 'change to copy individually',
    tasks: ['copy1'],
    register: registerJSMapSeparate,
    ops: {
      add: {
        'index.js': 'jsfile2',
        'index.js.map': 'mapfile2',
      }
    },
    outputs: {
      dev: {
        'index.js': 'jsfile2',
        'index.js.map': 'mapfile2',
      },
    },
    results: {
      fs_read: 2,
      fs_write: 2,
      fs_stat: 2,
      fs_delete: 0, // maybe 1 if jobs run in other order?
      warnings: 1,
      jobs: 2,
    },
  }]),

]);
