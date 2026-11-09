#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const binary = process.env.WORKSPACE_SANDBOX_BINARY || 'bwrap';
const limiter = process.env.WORKSPACE_LIMITER_BINARY || 'prlimit';
const run = (command, args) => spawnSync(command, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    timeout: 10000,
    windowsHide: true,
});

if (process.platform !== 'linux') {
    console.error('The local workspace command runner requires Linux.');
    process.exit(1);
}

const version = run(binary, ['--version']);
if (version.error || version.status !== 0) {
    console.error('Bubblewrap is not available. On Arch/CachyOS install it with:');
    console.error('  sudo pacman -S bubblewrap util-linux');
    if (version.error) console.error(version.error.message);
    process.exit(1);
}

const limiterCheck = run(limiter, ['--version']);
if (limiterCheck.error || limiterCheck.status !== 0) {
    console.error('prlimit is not available. On Arch/CachyOS install util-linux:');
    console.error('  sudo pacman -S util-linux');
    process.exit(1);
}

const probe = run(binary, [
    '--die-with-parent', '--new-session',
    '--unshare-user', '--disable-userns', '--assert-userns-disabled', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/etc', '/etc',
    // Same compatibility symlinks as lib/workspace.js: distros with a
    // root-level /lib64 -> usr/lib symlink (Arch/CachyOS) need them for the
    // ELF interpreter to resolve, otherwise execvp fails with ENOENT.
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/bin', '/sbin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/workspace', '--chdir', '/workspace',
    '/usr/bin/printf', 'workspace-sandbox-ready'
]);

if (probe.error || probe.status !== 0 || String(probe.stdout || '').trim() !== 'workspace-sandbox-ready') {
    console.error('Bubblewrap is installed but cannot create the required Linux namespaces.');
    console.error(String(probe.stderr || (probe.error && probe.error.message) || 'Unknown Bubblewrap error').trim());
    console.error('Check that unprivileged user namespaces are enabled by the kernel.');
    process.exit(1);
}

console.log('Local workspace sandbox is ready (' + String(version.stdout || '').trim() + ').');
console.log('Commands run on this computer; the host home directory is not mounted.');
