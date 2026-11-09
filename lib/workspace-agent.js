'use strict';

const MAX_WORKSPACE_ACTIONS = 8;
const DOWNLOAD_ROUTE_PREFIX = '/app/workspace/download?token=';

function formatWorkspaceToolResults(results) {
    const blocks = results.map((item, index) => {
        const result = typeof item.result === 'string' ? item.result : JSON.stringify(item.result);
        return 'Tool ' + (index + 1) + ': ' + item.name
            + '\nArguments: ' + JSON.stringify(item.arguments)
            + '\nResult:\n' + result;
    });
    return [
        '[WORKSPACE TOOL RESULTS]',
        ...blocks,
        'Continue the user task using these real tool results. You may request another workspace tool if needed. Do not claim an action succeeded unless its result confirms it. When files are ready, give the user the returned download links.'
    ].join('\n\n');
}

function parseDownloadResults(result) {
    try {
        const value = typeof result === 'string' ? JSON.parse(result) : result;
        if (!value || typeof value !== 'object') return [];
        const candidates = [value, ...(Array.isArray(value.entries) ? value.entries : [])];
        const output = [];
        for (const item of candidates) {
            if (!item || typeof item !== 'object') continue;
            if (typeof item.download_url !== 'string' || !item.download_url.startsWith(DOWNLOAD_ROUTE_PREFIX)) continue;
            output.push({
                path: String(item.path || item.name || 'file').replace(/[\[\]\r\n]/g, ' ').slice(0, 180),
                url: item.download_url
            });
        }
        return output;
    } catch {
        return [];
    }
}

function parseDownloadResult(result) {
    return parseDownloadResults(result)[0] || null;
}

function attachDownloadLinks(content, downloads) {
    const missing = [...downloads.values()].filter(item => !String(content || '').includes(item.url));
    if (!missing.length) return String(content || '');
    const lines = missing.map((item, index) => '- [Download ' + (index + 1) + ': ' + item.path + '](' + item.url + ')');
    const prefix = String(content || '').trim();
    return (prefix ? prefix + '\n\n' : '') + '**Workspace files**\n' + lines.join('\n');
}

function finish(content, reasoningContent, finishReason, activity, actionCount, limitReached, downloads) {
    return {
        content: attachDownloadLinks(content, downloads),
        reasoningContent,
        finishReason,
        activity,
        download_links: [...downloads.values()],
        action_count: actionCount,
        limit_reached: limitReached
    };
}

async function runWorkspaceAgentLoop({ initialContent, parseCalls, executeTool, requestContinuation, maxActions = MAX_WORKSPACE_ACTIONS }) {
    if (typeof parseCalls !== 'function' || typeof executeTool !== 'function' || typeof requestContinuation !== 'function') {
        throw new TypeError('parseCalls, executeTool and requestContinuation are required.');
    }
    let content = String(initialContent || '');
    let reasoningContent = '';
    let finishReason = null;
    let actionCount = 0;
    const activity = [];
    const downloads = new Map();

    while (actionCount < maxActions) {
        const calls = (await parseCalls(content) || []).filter(call => call && typeof call.name === 'string')
            .slice(0, maxActions - actionCount);
        if (!calls.length) return finish(content, reasoningContent, finishReason, activity, actionCount, false, downloads);
        const results = [];
        for (const call of calls) {
            actionCount++;
            let args = {};
            try {
                args = typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : (call.arguments || {});
            } catch {
                results.push({ name: call.name, arguments: {}, result: JSON.stringify({ error: 'Tool arguments were not valid JSON.', type: 'invalid_tool_arguments' }) });
                activity.push(call.name + ': invalid arguments');
                continue;
            }
            let result;
            try { result = await executeTool(call.name, args); }
            catch (error) { result = JSON.stringify({ error: String(error && error.message || 'Workspace action failed'), type: error && error.type || 'workspace_error' }); }
            for (const download of parseDownloadResults(result)) downloads.set(download.url, download);
            results.push({ name: call.name, arguments: args, result });
            let detail = call.name;
            if (args.path) detail += ' ' + args.path;
            else if (args.source) detail += ' ' + args.source;
            else if (args.command) detail += ': ' + String(args.command).replace(/\s+/g, ' ').slice(0, 120);
            activity.push(detail);
        }
        const next = await requestContinuation(formatWorkspaceToolResults(results));
        content = String(next && next.content || '');
        if (next && next.reasoningContent) reasoningContent = String(next.reasoningContent);
        finishReason = next && next.finishReason || null;
    }

    const remaining = await parseCalls(content) || [];
    const limitReached = remaining.length > 0;
    if (limitReached) content = '[WORKSPACE ACTION LIMIT] I stopped after ' + maxActions + ' workspace actions in this turn to keep execution bounded. Completed actions are preserved; ask me to continue.';
    return finish(content, reasoningContent, finishReason, activity, actionCount, limitReached, downloads);
}

module.exports = {
    MAX_WORKSPACE_ACTIONS,
    DOWNLOAD_ROUTE_PREFIX,
    formatWorkspaceToolResults,
    parseDownloadResult,
    parseDownloadResults,
    attachDownloadLinks,
    runWorkspaceAgentLoop
};
