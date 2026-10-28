'use strict';

var Route = require('../mentor-startup-route.js');
var dir = process.argv[2];
var now = new Date(process.argv[3]);
var result = Route.handle({
  method: 'GET',
  path: '/mentor-startup/plan',
  remote: '127.0.0.1',
  now: now,
  dir: dir
});
process.stdout.write(JSON.stringify({ speak: result.body.speak, reason: result.body.reason }));
