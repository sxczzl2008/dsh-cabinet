'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const FLOW_FILE = path.join(REPO_ROOT, 'backups/gh-device-flow.json');
const RECEIPT_FILE = path.join(REPO_ROOT, 'backups/github-push-receipt.json');
const LOG_FILE = path.join(REPO_ROOT, 'backups/github-push.log');

function log(msg) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
}

async function pollAndPush() {
  if (!fs.existsSync(FLOW_FILE)) return;
  const flow = JSON.parse(fs.readFileSync(FLOW_FILE, 'utf8'));
  const intervalMs = Math.max(5000, (flow.interval || 5) * 1000);
  const deadline = Date.now() + (flow.expires_in || 899) * 1000;

  log(`Started polling for user_code ${flow.user_code}`);

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: '178c6fc778ccc68e1d6a',
          device_code: flow.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
      });
      const data = await res.json();
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (data.error) {
        log(`OAuth error: ${JSON.stringify(data)}`);
        return;
      }
      if (data.access_token) {
        await completeRepoCreationAndPush(data.access_token);
        return;
      }
    } catch (err) {
      log(`Network retry: ${err.message}`);
    }
  }
  log('Device code expired before authorization.');
}

async function completeRepoCreationAndPush(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'dsh-cabinet-publisher'
  };

  const userRes = await fetch('https://api.github.com/user', { headers });
  const user = await userRes.json();
  const owner = user.login;
  log(`Authenticated as GitHub user: ${owner}`);

  const repoName = 'dsh-cabinet';
  const description = 'DeepSeek Harness (DSH) 多模型内阁协作工作流插件 — 纯鼠标气泡拖拽排席（1~9工作席+可选秘书席）、全局母本与单次对话子代双层配置、双审验自动返工闭环与 320px 窄版三色状态栏';

  let repoUrl = `https://github.com/${owner}/${repoName}`;
  const createRes = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: repoName,
      description,
      private: true,
      has_issues: true,
      has_wiki: false,
      auto_init: false
    })
  });

  if (createRes.status === 201 || createRes.status === 422) {
    await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ description, private: true })
    }).catch(() => {});

    await fetch(`https://api.github.com/repos/${owner}/${repoName}/topics`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        names: ['dsh', 'dsh-plugin', 'deepseek-harness', 'cabinet', 'multi-agent', 'multi-model', 'orchestrator', 'workflow']
      })
    }).catch(() => {});
  }

  // Update REPO_URL in package.json and lib/client.js with exact owner login
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.repository = { type: 'git', url: `git+https://github.com/${owner}/${repoName}.git` };
  pkg.homepage = `${repoUrl}#readme`;
  pkg.bugs = { url: `${repoUrl}/issues` };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  const clientPath = path.join(REPO_ROOT, 'lib/client.js');
  let clientTxt = fs.readFileSync(clientPath, 'utf8');
  clientTxt = clientTxt.replace(/var REPO_URL = "[^"]+";/, `var REPO_URL = "${repoUrl}";`);
  fs.writeFileSync(clientPath, clientTxt, 'utf8');

  const runGit = args => cp.execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
  runGit(['add', '-A']);
  try {
    runGit(['commit', '--amend', '--no-edit']);
  } catch {}
  runGit(['tag', '-f', 'v0.1.0']);

  try { runGit(['remote', 'remove', 'origin']); } catch {}
  runGit(['remote', 'add', 'origin', `${repoUrl}.git`]);

  // Store credential in Windows Git Credential Manager & push
  const credInput = `protocol=https\nhost=github.com\nusername=${owner}\npassword=${token}\n\n`;
  try {
    cp.execFileSync('git', ['credential-manager', 'store'], { input: credInput, encoding: 'utf8', windowsHide: true });
  } catch {}

  const authRemote = `https://${encodeURIComponent(owner)}:${encodeURIComponent(token)}@github.com/${owner}/${repoName}.git`;
  runGit(['push', '-u', authRemote, 'main', '--force']);
  runGit(['push', authRemote, 'refs/tags/v0.1.0', '--force']);

  const receipt = {
    completedAt: new Date().toISOString(),
    owner,
    repoName,
    private: true,
    repoUrl,
    branch: 'main',
    tag: 'v0.1.0',
    description
  };
  fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  log(`SUCCESS: Pushed main and v0.1.0 to ${repoUrl}`);

  try {
    cp.spawn('cmd.exe', ['/c', 'start', '', repoUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}

pollAndPush().catch(err => log(`Fatal: ${err.stack || err.message}`));
