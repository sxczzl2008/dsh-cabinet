'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const DEFAULT_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

function parseArgs(argv) {
  const out = { action: 'install', homeDir: DEFAULT_HOME };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--install') out.action = 'install';
    else if (a === '--uninstall') out.action = 'uninstall';
    else if (a === '--home' && argv[i + 1]) out.homeDir = path.resolve(argv[++i]);
  }
  return out;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function syncPluginToProfile(homeDir = DEFAULT_HOME) {
  const desktopDir = path.join(path.resolve(homeDir), 'profiles/desktop');
  if (!fs.existsSync(desktopDir)) {
    throw new Error(`未找到 DSH desktop profile 目录: ${desktopDir}`);
  }

  const legacyDir = path.join(desktopDir, 'node_modules/cabinet-v2-host');
  if (fs.existsSync(legacyDir)) fs.rmSync(legacyDir, { recursive: true, force: true });

  const destDir = path.join(desktopDir, 'node_modules/dsh-cabinet');
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  for (const f of ['package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md']) {
    const src = path.join(PLUGIN_ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, f));
  }
  copyDirRecursive(path.join(PLUGIN_ROOT, 'lib'), path.join(destDir, 'lib'));
  copyDirRecursive(path.join(PLUGIN_ROOT, 'scripts'), path.join(destDir, 'scripts'));

  const pluginVer = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version || '0.2.0';
  const desktopPkgFile = path.join(desktopDir, 'package.json');
  if (fs.existsSync(desktopPkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(desktopPkgFile, 'utf8'));
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies['dsh-cabinet'] = `file:${PLUGIN_ROOT.replace(/\\/g, '/')}`;
    pkg.dsh = pkg.dsh || {};
    pkg.dsh.profile = pkg.dsh.profile || {};
    const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
    if (!bundles.includes('dsh-cabinet')) bundles.push('dsh-cabinet');
    pkg.dsh.profile.bundles = bundles;
    fs.writeFileSync(desktopPkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
  return { destDir, pluginVer };
}

function installCabinet(homeDir = DEFAULT_HOME) {
  const profileSync = syncPluginToProfile(homeDir);
  const result = {
    ok: true,
    action: 'install',
    at: new Date().toISOString(),
    version: profileSync.pluginVer,
    pluginRepo: PLUGIN_ROOT,
    installedPluginDir: profileSync.destDir,
    mode: 'pure-bundle-external'
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function rollbackHostToVanilla(homeDir = DEFAULT_HOME) {
  const desktopDir = path.join(path.resolve(homeDir), 'profiles/desktop');
  const desktopPkgFile = path.join(desktopDir, 'package.json');
  if (fs.existsSync(desktopPkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(desktopPkgFile, 'utf8'));
    if (pkg.dependencies) delete pkg.dependencies['dsh-cabinet'];
    if (pkg.dsh?.profile?.bundles && Array.isArray(pkg.dsh.profile.bundles)) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== 'dsh-cabinet');
    }
    fs.writeFileSync(desktopPkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
  fs.rmSync(path.join(desktopDir, 'node_modules/dsh-cabinet'), { recursive: true, force: true });
  fs.rmSync(path.join(desktopDir, 'node_modules/cabinet-v2-host'), { recursive: true, force: true });
  const result = {
    ok: true,
    action: 'uninstall',
    at: new Date().toISOString(),
    mode: 'pure-bundle-external'
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  if (opts.action === 'uninstall') rollbackHostToVanilla(opts.homeDir);
  else installCabinet(opts.homeDir);
}

module.exports = { installCabinet, rollbackHostToVanilla, syncPluginToProfile };
