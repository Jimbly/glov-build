// const gb = require('glov-build');
const gb = require('../../');

require('./test_tasks.js').registerTasks();
gb.go(['clean']);
