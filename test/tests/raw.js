// const gb = require('glovjs-build');
const gb = require('../../');

require('./test_tasks.js').registerTasks();
gb.go(['clean']);
