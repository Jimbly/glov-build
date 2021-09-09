const { doTestList, multiTest } = require('./test_runner.js');

const {
  didRun, atlasLastReset, atlasLastNotReset,
} = require('./test_tasks.js');


doTestList([
  multiTest({ watch: true, serial: true }, [{
    name: 'initial',
    tasks: ['default'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "txt/file1.txt", "txt/file2.txt"]
}`,
        'txt/file1.asc': 'ascii1',
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'concat.txt': 'ascii1file1file2',
        'concat-reverse.txt': '1elif2elif',
        'my_atlas.txt': 'file1file2',
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      },
    },
    results: { // same for both
      checks: [
        didRun,
        atlasLastReset,
      ],
      fs_read: 4,
      fs_write: 7,
      fs_stat: 4,
      fs_delete: 0,
      errors: 1,
      warnings: 1,
      jobs: 12,
      phase_run: 8,
    },
  }, {
    name: 'delete 1',
    tasks: ['reduced'],
    ops: {
      del: [
        'txt/file1.txt'
      ]
    },
    outputs: {
      dev: {
        'concat.txt': 'ascii1file2',
        'concat-reverse.txt': '2elif',
        'my_atlas.txt': 'file2', // still output even with error; good idea? up to task?
        // 'txt/file1.txt': 'file1', // pruned
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      fs_write: 3,
      fs_delete: 2,
      jobs: 3,
      errors: 1,
      phase_run: 5,
    },
    results_watch: {
      checks: [atlasLastNotReset],
      fs_read: 0,
      fs_stat: 0,
    },
    results_serial: {
      checks: [atlasLastReset],
      fs_read: 4,
      fs_stat: 10, // was once 9?
    },
  }, {
    name: 'fix atlas',
    tasks: ['reduced'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "txt/file2.txt"]
}`,
      }
    },
    outputs: {
      dev: {
        'concat.txt': 'ascii1file2',
        'concat-reverse.txt': '2elif',
        'my_atlas.txt': 'file2', // updated
        // 'txt/file1.txt': 'file1', // pruned
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      checks: [atlasLastReset],
      fs_write: 0, // actual output unchanged
      fs_delete: 0,
      jobs: 1,
    },
    results_watch: {
      fs_read: 1,
      fs_stat: 0,
      phase_run: 1,
    },
    results_serial: {
      fs_read: 2,
      fs_stat: 9, // would be ~7 if isUpToDate early-outed
      phase_run: 5,
    },
  }, {
    name: 'broken atlas again',
    tasks: ['reduced'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "txt/file1.txt", "txt/file2.txt"]
}`,
      }
    },
    outputs: {
      dev: {
        'concat.txt': 'ascii1file2',
        'concat-reverse.txt': '2elif',
        'my_atlas.txt': 'file2',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      checks: [atlasLastReset],
      fs_write: 0, // actual output unchanged
      fs_delete: 0,
      errors: 1,
      warnings: 0,
      jobs: 1,
    },
    results_watch: {
      fs_read: 1,
      fs_stat: 0,
    },
    results_serial: {
      fs_read: 2,
      fs_stat: 9,
    },
  }, {
    name: 'fix by re-adding deleted file',
    tasks: ['reduced'],
    ops: {
      add: {
        'txt/file1.txt': 'file1b',
      }
    },
    outputs: {
      dev: {
        'concat.txt': 'ascii1file1bfile2',
        'concat-reverse.txt': 'b1elif2elif',
        'my_atlas.txt': 'file1bfile2',
        'txt/file1.txt': 'file1b',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      fs_write: 5,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 5,
    },
    results_watch: {
      checks: [atlasLastNotReset],
      fs_read: 1,
      fs_stat: 0,
    },
    results_serial: {
      checks: [atlasLastReset],
      fs_read: 5,
      fs_stat: 7,
    },
  }]),

  // Atlas dynamic reprocessing and caching
  multiTest({ watch: true, serial: true }, [{
    name: 'atlas dynamic reset',
    tasks: ['atlas'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "txt/file1.txt", "txt/file2.txt"]
}`,
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1file2',
      },
    },
    results: {
      checks: [atlasLastReset],
      fs_read: 3,
      fs_write: 1,
      fs_stat: 3,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 1,
    },
  }, {
    name: 'atlas dynamic mod',
    tasks: ['atlas'],
    ops: {
      add: {
        'txt/file1.txt': 'file1a',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1afile2',
      },
    },
    results: {
      fs_write: 1,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 1,
    },
    results_watch: {
      checks: [atlasLastNotReset],
      fs_read: 1,
      fs_stat: 0,
    },
    results_serial: {
      checks: [atlasLastReset],
    },
  }, {
    name: 'spurious change',
    tasks: ['atlas'],
    ops: {
      spurious: [
        'txt/file1.txt',
      ]
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1afile2',
      },
    },
    results: {
      fs_read: 0,
      fs_write: 0,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 0,
    },
    results_watch: {
      fs_stat: 0,
    },
    results_serial: {
      fs_stat: 4,
    },
  }]),

  multiTest({ watch: true, serial: true }, [{
    name: 'multiout (2)',
    tasks: ['multiout'],
    ops: {
      add: {
        'multi/multi1.json':
`{
  "outputs": {
    "multi1-a.txt": "m1a",
    "multi1-b.txt": "m1b"
  }
}`,
      }
    },
    outputs: {
      dev: {
        'multi1-a.txt': 'm1a',
        'multi1-b.txt': 'm1b',
      },
    },
    results: {
      jobs: 1,
    },
  }, {
    name: 'multiout (1)',
    tasks: ['multiout'],
    ops: {
      add: {
        'multi/multi1.json':
`{
  "outputs": {
    "multi1-a.txt": "m1a"
  }
}`,
      }
    },
    outputs: {
      dev: {
        'multi1-a.txt': 'm1a',
      },
    },
    results: {
      jobs: 1,
    },
  }]),

  // Warning tests
  multiTest({ watch: true, serial: true }, [{
    name: 'warns: initial',
    tasks: ['warns'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    results: {
      warnings: 1,
      jobs: 2,
    },
  }, {
    name: 'warns: no change',
    tasks: ['warns'],
    ops: {
      spurious: [
        'txt/file1.txt',
      ]
    },
    results_watch: {
      warnings: 0, // spurious changes causes nothing to happen while watching
      jobs: 0,
    },
    results_serial: {
      warnings: 1, // re-emits warning if running fresh
      jobs: 1, // re-runs the job to be safe
    },
  }, {
    name: 'warns: change other',
    tasks: ['warns'],
    ops: {
      add: {
        'txt/file1.txt': 'file1b',
      }
    },
    results: {
      warnings: 1, // still warns
    },
    results_watch: {
      jobs: 1, // runs only new job
    },
    results_serial: {
      jobs: 2, // also re-runs job that previously warned
    },
  }, {
    name: 'warns: delete bad',
    tasks: ['warns'],
    ops: {
      del: [
        'txt/file2.txt',
      ]
    },
    results: {
      warnings: 0, // warning removed
      jobs: 0,
    },
  }]),

  // warning/error handling tests and updated files counts in a task with deps
  multiTest({ watch: true, serial: true }, [{
    name: 'atlaswarn: initial',
    tasks: ['atlas'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "txt/file1.txt", "txt/file2.txt"]
}`,
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1file2',
      },
    },
    results: {
      files_updated: 3,
      fs_write: 1,
      warnings: 0,
      jobs: 1,
    },
  }, {
    name: 'atlaswarn: one change',
    tasks: ['atlas'],
    ops: {
      add: {
        'txt/file2.txt': 'file2b',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1file2b',
      },
    },
    results: {
      warnings: 0,
      jobs: 1,
    },
    results_watch: {
      files_updated: 1, // only one file shows as "updated"
    },
    results_serial: {
      files_updated: 3, // all files show as "updated" in a new process
    },
  }, {
    name: 'atlaswarn: file1 warns',
    tasks: ['atlas'],
    ops: {
      add: {
        'txt/file1.txt': 'warn',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'warnfile2b',
      },
    },
    results: {
      warnings: 1,
      jobs: 1,
    },
    results_watch: {
      files_updated: 1, // only one file shows as "updated"
    },
    results_serial: {
      files_updated: 3, // all files show as "updated" in a new process
    },
  }, {
    name: 'atlaswarn: change file2, file1 still warns',
    tasks: ['atlas'],
    ops: {
      add: {
        'txt/file2.txt': 'file2c',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'warnfile2c',
      },
    },
    results: {
      warnings: 1,
      jobs: 1,
    },
    results_watch: {
      files_updated: 2,
    },
    results_serial: {
      files_updated: 3,
    },
  }, {
    name: 'atlaswarn: file1 fixed',
    tasks: ['atlas'],
    ops: {
      add: {
        'txt/file1.txt': 'file1b',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1bfile2c',
      },
    },
    results: {
      warnings: 0,
      jobs: 1,
    },
    results_watch: {
      files_updated: 1, // only one file shows as "updated"
    },
    results_serial: {
      files_updated: 3, // all files show as "updated" in a new process
    },
  }, {
    name: 'atlaswarn: no change',
    tasks: ['atlas'],
    ops: {
      spurious: [
        'txt/file1.txt',
      ]
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1bfile2c',
      },
    },
    results: {
      files_updated: 0,
      warnings: 0,
      jobs: 0,
    },
  }]),

  multiTest({ watch: true, serial: true }, [{
    name: 'error block: initial',
    tasks: ['never_runs'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
    },
    results: {
      warnings: 0,
      errors: 1,
      jobs: 2,
    },
  },{
    name: 'error block: touch non-error',
    tasks: ['never_runs'],
    ops: {
      add: {
        'txt/file2.txt': 'file2b',
      }
    },
    outputs: {
    },
    results: {
      warnings: 0,
      errors: 1,
    },
    results_watch: {
      jobs: 1,
    },
    results_serial: {
      jobs: 2,
    },
  }]),

  multiTest({ watch: true, serial: true }, [{
    name: 'unchanged outputs: initial',
    tasks: ['concat-reverse'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'concat-reverse.txt': '1elif2elif',
      },
    },
    results: {
      jobs: 3,
    },
  }, {
    name: 'unchanged outputs: touch',
    tasks: ['concat-reverse'],
    ops: {
      add: {
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'concat-reverse.txt': '1elif2elif',
      },
    },
    results: {
      jobs: 1,
    },
  }]),

  multiTest({ serial: true }, [{
    name: 'unchanged outputs with dependors: initial',
    tasks: ['copy_unchanged'],
    ops: {
      add: {
        'file1': 'contents',
        'file2': 'contents',
      }
    },
    outputs: {
      dev: {
        'file1': 'file1',
        'file2': 'file2',
      },
    },
    results: {
      jobs: 4,
    },
  }, {
    // When serial, this was pruning 'file1' from the output because of not re-writing unchanged files
    name: 'unchanged outputs with dependors: touch',
    tasks: ['copy_unchanged'],
    ops: {
      add: {
        'file1': 'modified',
      }
    },
    outputs: {
      dev: {
        'file1': 'file1',
        'file2': 'file2',
      },
    },
    results_serial: {
      jobs: 2,
    },
    results_watch: {
      jobs: 1,
    }
  }]),

  multiTest({ serial: true, watch: true }, [{
    name: 'meta task from simple tasks to dev',
    tasks: ['from_metadev'],
    ops: {
      add: {
        'file1': 'file1',
        'file2': 'file2',
      }
    },
    outputs: {
      dev: {
        'file1': 'file1',
        'file2': 'file2',
        'meta/file1': 'file1',
        'meta/file2': 'file2',
      },
    },
    results: {
      fs_read: 2,
      fs_write: 4,
      fs_stat: 2,
      jobs: 4,
    },
  }, {
    name: 'meta task from simple tasks to dev, dynamic change',
    tasks: ['from_metadev'],
    ops: {
      add: {
        'file1': 'file1b',
      }
    },
    outputs: {
      dev: {
        'file1': 'file1b',
        'file2': 'file2',
        'meta/file1': 'file1b',
        'meta/file2': 'file2',
      },
    },
    results: {
      fs_read: 1,
      fs_write: 2,
      jobs: 2,
    },
  }]),

  multiTest({ serial: true, watch: true }, [{
    name: 'meta task from simple tasks to intermediate',
    tasks: ['from_meta'],
    ops: {
      add: {
        'file1': 'file1',
        'file2': 'file2',
      }
    },
    outputs: {
      dev: {
        'file1': 'file1',
        'file2': 'file2',
      },
    },
    results: {
      fs_read: 2,
      fs_write: 4,
      fs_stat: 2,
      jobs: 4,
    },
  }]),

  // Test for loader returning ERR_DOES_NOT_EXIST when file.err should have been cleared
  multiTest({ watch: true, serial: true }, [{
    name: 'removing file: initial',
    tasks: ['atlas_from_copy'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "copy_to_int:txt/file1.txt", "copy_to_int:txt/file2.txt"]
}`,
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1file2',
      },
    },
    results: { // same for both
      checks: [
        atlasLastReset,
      ],
      errors: 0,
      jobs: 2,
    },
  }, {
    name: 'removing file: remove file',
    reset: true,
    tasks: ['atlas_from_copy'],
    ops: {
      del: [
        'txt/file2.txt',
      ]
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1file2', // unchanged
      },
    },
    results: {
      checks: [
        atlasLastReset,
      ],
      errors: 1,
      jobs: 1,
    },
  },{
    name: 'add missing file',
    tasks: ['atlas_from_copy'],
    ops: {
      add: {
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1file2',
      },
    },
    results: {
      errors: 0,
      jobs: 2,
    },
  }]),

  // Case sensitivity tests
  multiTest({ watch: true, serial: true }, [{
    name: 'case sensitivity: intermediate',
    tasks: ['atlas_from_copy'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "copy_to_int:txt/FiLe1.txt", "copy_to_int:TXT/file2.txt"]
}`,
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': '',
      },
    },
    results: { // same for both
      checks: [
        atlasLastReset,
      ],
      errors: 2,
      jobs: 2,
    },
  }]),

  multiTest({ watch: true, serial: true }, [{
    name: 'case sensitivity: source',
    tasks: ['atlas'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "txt/FiLe1.txt", "TXT/file1.txt"]
}`,
        'txt/file1.txt': 'file1',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': '',
      },
    },
    results: { // same for both
      errors: 2,
      jobs: 1,
    },
  }]),

  // Test runner was previously clearing process.exitCode here
  // Build was previously not re-outputting old errors here
  multiTest({ watch: true, serial: true }, [{
    name: 'error and spurious and unrelated: init',
    tasks: ['errors', 'simple1dev'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'file1': 'file1simple',
      },
    },
    outputs: {
      dev: {
        'file1': 'file1simple',
      },
    },
    results: {
      jobs: 2,
      errors: 1,
    },
  },{
    name: 'error and spurious and unrelated: spurious',
    tasks: ['errors', 'simple1dev'],
    ops: {
      spurious: [
        'txt/file1.txt',
      ]
    },
    outputs: {
      dev: {
        'file1': 'file1simple',
      },
    },
    results_watch: {
      jobs: 0,
      errors: 0,
    },
    results_serial: {
      jobs: 1, // re-runs errored job
      errors: 1, // re-outputs errors
    },
  }, {
    name: 'error and spurious and unrelated: unrelated',
    tasks: ['errors', 'simple1dev'],
    ops: {
      add: {
        'file1': 'file1simpleB',
      },
    },
    outputs: {
      dev: {
        'file1': 'file1simpleB',
      },
    },
    results: {
      errors: 1,
      jobs: 1,
    },
    results_serial: {
      jobs: 2,
    },
  }]),

  // This was erroring because isUpToDate was forcing jobs to re-run if any dep errored
  multiTest({ watch: true, serial: true }, [{
    name: 'expected missing file',
    tasks: ['atlas', 'copy'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "txt/file1.txt", "expected_missing"]
}`,
        'txt/file1.txt': 'file1',
      }
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
        'my_atlas.txt': 'file1',
      },
    },
    results: {
      checks: [atlasLastReset],
      fs_read: 2,
      fs_write: 2,
      fs_stat: 3,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 2,
    },
  }, {
    name: 'expected missing file: unrelated change',
    tasks: ['atlas', 'copy'],
    ops: {
      add: {
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
        'my_atlas.txt': 'file1',
      },
    },
    results: {
      fs_read: 1,
      fs_write: 1,
      fs_stat: 1,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 1,
    },
    results_serial: {
      fs_stat: 6,
    },
  }]),

  // This was erroring because sourcing from a task which output to a target was
  // not getting file change notifications propagated with the right key to get
  // added into the dynamic dep gathering.
  multiTest({ watch: true, serial: true }, [{
    name: 'execish',
    tasks: ['execish'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
      }
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
      },
    },
    results: {
      checks: [didRun],
      fs_read: 1,
      fs_write: 1,
      fs_stat: 1,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 2,
    },
  }, {
    name: 'execish: modify file',
    tasks: ['execish'],
    ops: {
      add: {
        'txt/file1.txt': 'file1b',
      }
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1b',
      },
    },
    results: {
      checks: [didRun],
      fs_read: 1,
      fs_write: 1,
      fs_stat: 0,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 2,
    },
    results_serial: {
      fs_read: 1,
      fs_stat: 2,
    },
  }, {
    name: 'execish: add new file',
    tasks: ['execish'],
    ops: {
      add: {
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1b',
        'txt/file2.txt': 'file2',
      },
    },
    results: {
      checks: [didRun],
      fs_read: 1,
      fs_write: 1,
      fs_stat: 1,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 2,
    },
    results_serial: {
      fs_read: 2,
      fs_stat: 3,
    },
  }]),

  multiTest({ serial: true }, [{
    name: 'execish2: do not read',
    tasks: ['execish2'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
      }
    },
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
      },
    },
    results: {
      checks: [didRun],
      fs_read: 1,
      fs_write: 1,
      fs_stat: 1,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 2,
    },
  }, {
    name: 'execish2: do not read: no change',
    tasks: ['execish2'],
    outputs: {
      dev: {
        'txt/file1.txt': 'file1',
      },
    },
    results: {
      checks: [didRun],
      fs_read: 0,
      fs_write: 0,
      fs_stat: 2,
      fs_delete: 0,
      errors: 0,
      warnings: 0,
      jobs: 1,
    },
  }]),

  multiTest({ watch: true, serial: true }, [{
    name: 'removing file after restart: initial',
    tasks: ['atlas'],
    ops: {
      add: {
        'atlas/atlas1.json':
`{
  "output": "my_atlas.txt",
  "inputs": [ "txt/file1.txt", "txt/file2.txt"]
}`,
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1file2',
      },
    },
    results: {
      checks: [
        atlasLastReset,
      ],
      errors: 0,
      jobs: 1,
    },
  }, {
    name: 'removing file after restart: spurious',
    tasks: ['atlas'],
    reset: true, // start up, run all tasks, but don't do anything
    ops: {
      spurious: [
        'txt/file2.txt',
      ],
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1file2',
      },
    },
    results: {
      errors: 0,
      jobs: 0,
    },
  }, {
    // then dynamic update that removes the file
    name: 'removing file after restart: remove file',
    tasks: ['atlas'],
    ops: {
      del: [
        'txt/file2.txt',
      ]
    },
    outputs: {
      dev: {
        'my_atlas.txt': 'file1',
      },
    },
    results: {
      checks: [
        atlasLastReset,
      ],
      errors: 1,
      jobs: 1,
    },
  }]),

  multiTest({ watch: true, serial: true }, [{
    name: 'removing file from ALL task after restart: initial',
    tasks: ['concat'],
    ops: {
      add: {
        'txt/file1.txt': 'file1',
        'txt/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'concat.txt': 'file1file2',
      },
    },
    results: {
      errors: 0,
      jobs: 1,
    },
  }, {
    name: 'removing file from ALL task after restart: spurious',
    tasks: ['concat'],
    reset: true, // start up, run all tasks, but don't do anything
    ops: {
      spurious: [
        'txt/file2.txt',
      ],
    },
    outputs: {
      dev: {
        'concat.txt': 'file1file2',
      },
    },
    results: {
      errors: 0,
      jobs: 0,
    },
  }, {
    // then dynamic update that removes the file
    name: 'removing file from ALL task after restart: remove file',
    tasks: ['concat'],
    ops: {
      del: [
        'txt/file2.txt',
      ]
    },
    outputs: {
      dev: {
        'concat.txt': 'file1',
      },
    },
    results: {
      errors: 0,
      jobs: 1,
    },
  }]),

  multiTest({ watch: true, serial: true }, [{
    name: 'copy to root: initial',
    tasks: ['copy_to_root'],
    ops: {
      add: {
        'dir1/file1.txt': 'file1',
        'dir1/file2.txt': 'file2',
      }
    },
    outputs: {
      dev: {
        'file1.txt': 'file1',
        'file2.txt': 'file2',
      },
    },
    results: {
      errors: 0,
      jobs: 2,
    },
  }, {
    name: 'copy to root: new duplicate',
    tasks: ['copy_to_root'],
    ops: {
      add: {
        'dir1/file3.txt': 'file3a',
        'dir2/file3.txt': 'file3b',
      }
    },
    outputs: {
      dev: {
        'file1.txt': 'file1',
        'file2.txt': 'file2',
        'file3.txt': 'file3a', // not guaranteed? not important for what we're testing, though # of jobs ran will change
      },
    },
    results: {
      errors: 1,
      jobs: 2,
    },
  }, {
    name: 'copy to root: remove duplicate',
    tasks: ['copy_to_root'],
    ops: {
      del: [
        'dir1/file3.txt',
      ],
    },
    outputs: {
      dev: {
        'file1.txt': 'file1',
        'file2.txt': 'file2',
        'file3.txt': 'file3b',
      },
    },
    results: {
      errors: 0,
      jobs: 1,
    },
  }, {
    name: 'copy to root: incremental duplicate',
    tasks: ['copy_to_root'],
    ops: {
      add: {
        'dir2/file1.txt': 'file1',
      },
    },
    outputs: {
      dev: {
        'file1.txt': 'file1',
        'file2.txt': 'file2',
        'file3.txt': 'file3b',
      },
    },
    results: {
      errors: 1,
      jobs: 1,
    },
  }, {
    name: 'copy to root: remove orig duplicate',
    tasks: ['copy_to_root'],
    ops: {
      del: [
        'dir1/file1.txt',
      ],
    },
    outputs: {
      dev: {
        'file1.txt': 'file1',
        'file2.txt': 'file2',
        'file3.txt': 'file3b',
      },
    },
    results: {
      errors: 0,
      jobs: 1,
    },
  }]),

]);
