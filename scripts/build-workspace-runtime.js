#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runtime = process.env.WORKSPACE_CONTAINER_RUNTIME || 'docker';
const image = process.env.WORKSPACE_RUNTIME_IMAGE || 'freeapi-workspace:local';
const result = spawnSync(runtime, ['build', '--tag', image, '--file', path.join(root, 'workspace', 'Dockerfile'), root], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
});

if (result.error) {
    console.error('Could not start ' + runtime + ': ' + result.error.message);
    process.exitCode = 1;
} else if (result.status !== 0) {
    process.exitCode = result.status || 1;
} else {
    console.log('Workspace runtime is ready: ' + image);
}
