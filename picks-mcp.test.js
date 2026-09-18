const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const child = spawn(process.execPath, ['picks-mcp.js'], { cwd:__dirname, env:{...process.env, PICKS_TOKEN_FILE:'/definitely/missing'} });
let output = '';
child.stdout.on('data', chunk => {
  output += chunk;
  const lines = output.trim().split('\n').filter(Boolean);
  if (lines.length !== 2) return;
  const responses = lines.map(JSON.parse);
  assert.equal(responses[0].result.serverInfo.name, 'sports-picks-local');
  assert.deepEqual(
    responses[1].result.tools.map(tool => tool.name),
    [
      'sports_picks_freshness',
      'sports_picks_read',
      'sports_picks_capture',
      'sports_picks_transcribe_video',
      'sports_picks_ocr_frames',
      'sports_picks_source_check',
      'sports_picks_run_receipt',
    ],
  );
  child.kill();
});
child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})+'\n');
child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\n');
setTimeout(() => { throw new Error('MCP server did not answer in time'); }, 1000).unref();
child.on('close', () => { console.log('picks-mcp tests passed'); });
