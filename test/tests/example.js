const gb = require('../../');

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
