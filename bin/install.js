#!/usr/bin/env node
import readline from 'node:readline';
import {
  checkDesktopAppInstalled,
  installDesktopApp,
  checkCodexInstalled,
  installCodexCli,
  configureCodex
} from '../src/codexInstaller.js';

function askQuestion(query, defaultAnswer = '1') {
  if (!process.stdin.isTTY) {
    return Promise.resolve(defaultAnswer);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim() || defaultAnswer);
    });
  });
}

async function main() {
  console.log('\n======================================================');
  console.log('  SE-AiProxy — Universal Installer');
  console.log('  Automated Setup for OpenAI Codex (Desktop & CLI)');
  console.log('  by shirazelectronic — https://shirazelectronic.ir');
  console.log('======================================================\n');

  const args = process.argv.slice(2);
  let choice = '1';

  if (args.includes('--desktop')) choice = '1';
  else if (args.includes('--cli')) choice = '2';
  else if (args.includes('--both')) choice = '3';
  else if (args.includes('--skip')) choice = '4';
  else {
    console.log('Which edition of OpenAI Codex would you like to set up?');
    console.log('  [1] Codex Desktop App (GUI Application) [Recommended]');
    console.log('  [2] Codex CLI (Terminal Command Line Tool)');
    console.log('  [3] Both (Desktop App & CLI)');
    console.log('  [4] Skip installation (Configure proxy connection only)\n');

    choice = await askQuestion('Select an option (1, 2, 3, 4) [1]: ', '1');
  }

  console.log('\n------------------------------------------------------');

  // Step 1: Handle Desktop App installation
  if (choice === '1' || choice === '3') {
    console.log('[1/3] Checking Codex Desktop App status...');
    const desktopStatus = checkDesktopAppInstalled();
    if (desktopStatus.installed) {
      console.log(`   [OK] Desktop App is already installed on your system.`);
      console.log(`   Location: ${desktopStatus.appPath}`);
    } else {
      console.log('   [INFO] Installing Codex Desktop App...');
      const dRes = await installDesktopApp();
      if (dRes.success) {
        if (dRes.appPath) console.log(`   [OK] Desktop App installed successfully (${dRes.appPath})`);
        else if (dRes.manual) console.log(`   [INFO] Official download page opened in your browser. Please complete the installer.`);
      } else {
        console.warn(`   [WARNING] ${dRes.error}`);
      }
    }
  }

  // Step 2: Handle CLI installation
  if (choice === '2' || choice === '3') {
    console.log('\n[2/3] Checking Codex CLI status...');
    const cliStatus = checkCodexInstalled();
    if (cliStatus.installed) {
      console.log(`   [OK] Codex CLI is already installed on your system.`);
      console.log(`   Location: ${cliStatus.binPath} (${cliStatus.version || 'ready'})`);
    } else {
      console.log('   [INFO] Downloading and installing Codex CLI...');
      const cliRes = await installCodexCli();
      if (cliRes.success) {
        console.log(`   [OK] Codex CLI installed successfully!`);
      } else {
        console.warn(`   [WARNING] ${cliRes.error}`);
      }
    }
  }

  // Step 3: Configure proxy connection (~/.codex/config.toml & API keys)
  console.log('\n[3/3] Configuring Codex to connect to DeepSeek Proxy...');
  try {
    const configRes = await configureCodex({ port: 18789 });
    console.log(`   [OK] Codex config updated: ${configRes.configPath}`);
    console.log(`   [OK] Default model set to: deepseek-reasoner (1M context window)`);
    console.log(`   [OK] Provider (se_aiproxy) & secure auth key configured.`);
    console.log(`   [OK] Settings applied for both Desktop App and CLI.`);
  } catch (err) {
    console.error(`   [ERROR] Configuration failed: ${err.message}`);
  }

  // Summary
  console.log('\n======================================================');
  console.log('  Setup Complete!');
  console.log('======================================================\n');
  console.log('Next Steps:');
  console.log('  1. Start the proxy server:');
  if (process.platform === 'win32') {
    console.log('     Open folder "windows" -> double-click "start.bat"');
  } else if (process.platform === 'darwin') {
    console.log('     Open folder "macos" -> double-click "start.command" (or ./start.sh)');
  } else {
    console.log('     Open folder "linux" -> run "./start.sh"');
  }
  console.log('\n  2. Open the Web Dashboard in your browser:');
  console.log('     http://127.0.0.1:18789');
  console.log('     (Add your DeepSeek web account or click "Chrome Login" to extract token)');
  console.log('\n  3. Launch Codex Desktop App or run "codex" in any terminal.\n');
}

main().catch(err => {
  console.error('\n[FATAL ERROR] Setup encountered an issue:', err);
  process.exit(1);
});
