const fs = require('fs');
const child_process = require('child_process');

const SKIP = {
  'test_runner.js': true,
  'test_tasks.js': true,
  'test_async_fork.js': true, // not currently working
  'test_locked_file.js': true, // requires native modules not updated for current Node.js
};

fs.readdirSync(`${__dirname}/tests`).forEach(function (fname) {
  if ((/^.*\.js$/).test(fname) && !fname.startsWith('example') && !fname.startsWith('raw') && !SKIP[fname]) {
    console.log(`${fname}...`);
    child_process.execSync(`node ${__dirname}/tests/${fname}`, {
      stdio: 'inherit',
    });
  }
});
