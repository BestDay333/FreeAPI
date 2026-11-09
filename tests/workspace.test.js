'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { createWorkspaceManager, executeWorkspaceTool, normalizeRelativePath, isPublicIp, workspaceToolDefinitions } = require('../lib/workspace');

async function temporaryManager(options = {}) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'freeapi-workspace-test-'));
    return { root, manager: createWorkspaceManager({ root, ...options }), cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

function fakeSpawnFactory(exitCode = 0) {
    const calls = [];
    const spawnImpl = (command, args, options) => {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        process.nextTick(() => { child.stdout.end('workspace command output\n'); child.stderr.end(''); child.emit('close', exitCode, null); });
        return child;
    };
    return { calls, spawnImpl };
}

test('workspace paths reject absolute paths, traversal, empty segments and drive prefixes', () => {
    for (const value of ['/etc/passwd', '../secret', 'a/../b', 'a//b', 'C:/secret', '']) {
        assert.throws(() => normalizeRelativePath(value), { type: 'invalid_path' });
    }
    assert.equal(normalizeRelativePath('', true), '');
    assert.equal(normalizeRelativePath('projects/demo/file.txt'), 'projects/demo/file.txt');
});

test('workspace files can be created, read, listed and safely downloaded', async t => {
    const env = await temporaryManager();
    t.after(env.cleanup);
    const manager = createWorkspaceManager({ root: env.root, downloadUrlForPath: relative => '/download?path=' + encodeURIComponent(relative) });
    const written = await manager.writeFile('projects/demo/hello.txt', 'Привет, мир!');
    assert.match(written.download_url, /hello/);
    const read = await manager.readFile('projects/demo/hello.txt');
    assert.equal(read.content, 'Привет, мир!');
    assert.ok(read.download_url);
    const listed = (await manager.listFiles('projects/demo')).entries[0];
    assert.equal(listed.name, 'hello.txt');
    assert.ok(listed.download_url);
    const renamed = await manager.renameFile('projects/demo/hello.txt', 'projects/demo/welcome.txt');
    assert.equal(renamed.new_path, 'projects/demo/welcome.txt');
    assert.equal((await manager.readFile('projects/demo/welcome.txt')).content, 'Привет, мир!');
    const opened = await manager.openDownload('projects/demo/welcome.txt');
    assert.equal(opened.stat.size, Buffer.byteLength('Привет, мир!'));
    await opened.handle.close();
});

test('workspace refuses to follow symbolic links', async t => {
    const env = await temporaryManager();
    t.after(env.cleanup);
    await fsp.symlink(os.tmpdir(), path.join(env.root, 'outside'));
    await assert.rejects(env.manager.readFile('outside/secret.txt'), { type: 'symlink_blocked' });
    await assert.rejects(env.manager.writeFile('outside/secret.txt', 'bad'), { type: 'symlink_blocked' });
});

test('workspace delete is non-recursive for directories', async t => {
    const env = await temporaryManager();
    t.after(env.cleanup);
    await env.manager.writeFile('folder/file.txt', 'data');
    await assert.rejects(env.manager.deleteFile('folder'), { code: 'ENOTEMPTY' });
    await env.manager.deleteFile('folder/file.txt');
    await env.manager.deleteFile('folder');
});

test('workspace downloads reject local/private addresses and unsupported schemes', async t => {
    const env = await temporaryManager();
    t.after(env.cleanup);
    await assert.rejects(env.manager.downloadUrl('http://127.0.0.1/private', 'private.txt'), { type: 'unsafe_url' });
    await assert.rejects(env.manager.downloadUrl('http://localhost/private', 'private.txt'), { type: 'unsafe_url' });
    await assert.rejects(env.manager.downloadUrl('file:///etc/passwd', 'private.txt'), { type: 'unsafe_url' });
});

test('public IP validation rejects local and reserved addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '224.0.0.1']) assert.equal(isPublicIp(ip), false, ip);
    assert.equal(isPublicIp('8.8.8.8'), true);
    assert.equal(isPublicIp('2001:4860:4860::8888'), true);
    assert.equal(isPublicIp('2001:db8::1'), false);
    assert.equal(isPublicIp('fe80::1'), false);
});

test('workspace commands run locally through Bubblewrap with a restricted mount namespace', async t => {
    const fake = fakeSpawnFactory();
    const env = await temporaryManager({ spawnImpl: fake.spawnImpl });
    t.after(env.cleanup);
    const result = await env.manager.runCommand({ command: 'printf hello' });
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, 'workspace command output\n');
    assert.equal(result.runner, 'bubblewrap');
    const call = fake.calls[0];
    assert.equal(call.command, 'prlimit');
    assert.ok(call.args.includes('--as=12884901888'));
    assert.ok(call.args.includes('--nproc=768'));
    assert.ok(call.args.includes('--fsize=1073741824'));
    assert.ok(call.args.includes('--cpu=300'));
    const bwrapIndex = call.args.indexOf('bwrap');
    assert.ok(bwrapIndex > 0, 'Bubblewrap is launched through prlimit');
    const args = call.args.slice(bwrapIndex + 1);
    for (const flag of ['--unshare-user', '--disable-userns', '--assert-userns-disabled', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net', '--ro-bind', '--proc', '--dev', '--tmpfs', '--bind', '--chdir', '--clearenv', '--setenv', '--cap-drop']) {
        assert.ok(args.includes(flag), 'missing ' + flag);
    }
    const bindIndex = args.indexOf('--bind');
    assert.equal(args[bindIndex + 1], env.root);
    assert.equal(args[bindIndex + 2], '/workspace');
    assert.equal(args.filter(arg => arg === '--bind').length, 1, 'only the conversation workspace is writable on the host');
    assert.ok(!args.includes(process.env.HOME), 'host home directory is not mounted');
    await env.manager.runCommand({ command: 'npm install', network: true });
    const onlineArgs = fake.calls[1].args.slice(fake.calls[1].args.indexOf('bwrap') + 1);
    assert.ok(!onlineArgs.includes('--unshare-net'), 'internet is enabled only when the tool opts in');
    await assert.rejects(env.manager.runCommand({ command: 'pwd', cwd: 'missing-directory' }), { type: 'not_found' });
    assert.equal(fake.calls.length, 2);
});

test('workspace reports a clear error when Bubblewrap or prlimit is missing', async t => {
    const env = await temporaryManager({
        spawnImpl() {
            const error = new Error('spawn prlimit ENOENT');
            error.code = 'ENOENT';
            throw error;
        }
    });
    t.after(env.cleanup);
    await assert.rejects(
        env.manager.runCommand({ command: 'printf hello' }),
        error => error.type === 'sandbox_unavailable' && /pacman -S bubblewrap util-linux/.test(error.message)
    );
});

test('real Bubblewrap smoke test hides host temporary files and writes only in the workspace', {
    skip: process.platform !== 'linux' || spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).status !== 0
}, async t => {
    const env = await temporaryManager();
    t.after(env.cleanup);
    const outside = path.join(os.tmpdir(), 'freeapi-workspace-host-' + process.pid + '.txt');
    await fsp.writeFile(outside, 'host-only-secret');
    t.after(() => fsp.rm(outside, { force: true }));
    const command = 'test ! -e ' + JSON.stringify(outside) + ' && printf local-sandbox > result.txt && cat result.txt';
    const result = await env.manager.runCommand({ command });
    assert.equal(result.exit_code, 0, result.stderr);
    assert.equal(result.stdout, 'local-sandbox');
    assert.equal((await env.manager.readFile('result.txt')).content, 'local-sandbox');
});

test('workspace dispatcher exposes only declared workspace actions', async t => {
    const fake = fakeSpawnFactory();
    const env = await temporaryManager({ spawnImpl: fake.spawnImpl });
    t.after(env.cleanup);
    const output = await executeWorkspaceTool(env.manager, 'workspace_write_file', { path: 'answer.txt', content: '42' });
    assert.match(output, /answer\.txt/);
    await assert.rejects(executeWorkspaceTool(env.manager, 'exec_host_shell', {}), { type: 'unknown_tool' });
    assert.deepEqual(workspaceToolDefinitions().map(item => item.function.name), [
        'workspace_list_files', 'workspace_read_file', 'workspace_write_file', 'workspace_create_directory',
        'workspace_delete_file', 'workspace_rename_file', 'workspace_download', 'workspace_run', 'workspace_archive'
    ]);
});

test('workspace archive destinations cannot overwrite or be placed inside the source', async t => {
    const env = await temporaryManager();
    t.after(env.cleanup);
    await env.manager.createDirectory('project');
    await env.manager.writeFile('project/readme.txt', 'hello');
    await assert.rejects(env.manager.archive('project', 'project/bundle.zip'), { type: 'invalid_archive_path' });
    await assert.rejects(env.manager.archive('project/readme.txt', 'project/readme.txt'), { type: 'invalid_archive_path' });
});

test('workspace tool results stay valid JSON when file content or command output is large', async t => {
    const env = await temporaryManager();
    t.after(env.cleanup);
    await env.manager.writeFile('large.txt', 'x'.repeat(60000));
    const result = await executeWorkspaceTool(env.manager, 'workspace_read_file', { path: 'large.txt' });
    const parsed = JSON.parse(result);
    assert.equal(parsed.path, 'large.txt');
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.size, 60000);
    assert.equal(parsed.content.length, 24000);
    assert.ok(result.length <= 96000);
});
