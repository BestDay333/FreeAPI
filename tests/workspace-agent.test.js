'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWorkspaceAgentLoop, formatWorkspaceToolResults, parseDownloadResult, parseDownloadResults } = require('../lib/workspace-agent');

test('workspace agent executes tools, feeds real results back and returns every output link', async () => {
    const executions = [];
    const prompts = [];
    const result = await runWorkspaceAgentLoop({
        initialContent: 'first tool',
        parseCalls: async content => {
            if (content === 'first tool') return [{ name: 'workspace_write_file', arguments: '{"path":"hello.txt","content":"hello"}' }];
            if (content === 'second tool') return [{ name: 'workspace_archive', arguments: '{"source":"hello.txt"}' }];
            return [];
        },
        executeTool: async (name, args) => {
            executions.push({ name, args });
            return JSON.stringify({ path: args.path || 'bundle.zip', size: 10, download_url: '/app/workspace/download?token=abc' + executions.length });
        },
        requestContinuation: async prompt => { prompts.push(prompt); return { content: prompts.length === 1 ? 'second tool' : 'Finished.' }; }
    });
    assert.equal(result.content, 'Finished.\n\n**Workspace files**\n- [Download 1: hello.txt](/app/workspace/download?token=abc1)\n- [Download 2: bundle.zip](/app/workspace/download?token=abc2)');
    assert.equal(result.action_count, 2);
    assert.deepEqual(executions.map(item => item.name), ['workspace_write_file', 'workspace_archive']);
    assert.match(prompts[0], /"size":10/);
    assert.equal(result.download_links.length, 2);
});

test('workspace agent passes tool errors back and stops at the action limit', async () => {
    let continuations = 0;
    const result = await runWorkspaceAgentLoop({
        initialContent: 'tool',
        maxActions: 2,
        parseCalls: async content => content === 'done' ? [] : [{ name: 'workspace_run', arguments: '{"command":"echo hi"}' }],
        executeTool: async () => { throw Object.assign(new Error('runtime unavailable'), { type: 'runtime_unavailable' }); },
        requestContinuation: async prompt => { continuations++; assert.match(prompt, /runtime unavailable/); return { content: 'tool' }; }
    });
    assert.equal(result.action_count, 2);
    assert.equal(result.limit_reached, true);
    assert.match(result.content, /WORKSPACE ACTION LIMIT/);
    assert.equal(continuations, 2);
});

test('workspace tool-result prompt carries its results and filters download URL shapes', () => {
    const prompt = formatWorkspaceToolResults([{ name: 'workspace_list_files', arguments: { path: '' }, result: '{"entries":[]}' }]);
    assert.match(prompt, /workspace_list_files/);
    assert.match(prompt, /"entries":\[\]/);
    assert.match(prompt, /Do not claim an action succeeded/);
    assert.equal(parseDownloadResult('{"download_url":"https://evil.example/file"}'), null);
    assert.equal(parseDownloadResult('{"download_url":"/app/workspace/download?token=abc","path":"file.txt"}').path, 'file.txt');
    assert.equal(parseDownloadResults('{"entries":[{"type":"file","path":"built/app.zip","download_url":"/app/workspace/download?token=zip"}]}').length, 1);
});
