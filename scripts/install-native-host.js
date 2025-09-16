#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

function log(message) {
  console.log(`[Native Host Installer] ${message}`);
}

function getNativeHostPath() {
  const platform = os.platform();
  const homeDir = os.homedir();

  switch (platform) {
    case 'darwin':
      return path.join(homeDir, 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
    case 'win32':
      // Windows registry path would be used instead, but for file-based:
      return path.join(homeDir, 'AppData/Local/Google/Chrome/User Data/NativeMessagingHosts');
    case 'linux':
      return path.join(homeDir, '.config/google-chrome/NativeMessagingHosts');
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

function installNativeHost() {
  const sourceFile = path.resolve(__dirname, '..', 'native-host', 'playwright-crx-host.json');
  const nativeHostDir = getNativeHostPath();
  const targetFile = path.join(nativeHostDir, 'com.playwright.crx.host.json');

  log(`Installing native messaging host...`);
  log(`Source: ${sourceFile}`);
  log(`Target: ${targetFile}`);

  // Create directory if it doesn't exist
  if (!fs.existsSync(nativeHostDir)) {
    fs.mkdirSync(nativeHostDir, { recursive: true });
    log(`Created directory: ${nativeHostDir}`);
  }

  // Read and modify the host configuration
  const hostConfig = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));

  // Update path based on current system
  if (os.platform() === 'darwin') {
    hostConfig.path = '/Applications/Invader Zim.app/Contents/Resources/playwright-crx-host';
  } else if (os.platform() === 'win32') {
    hostConfig.path = 'C:\\Program Files\\Invader Zim\\playwright-crx-host.exe';
  } else {
    hostConfig.path = '/usr/local/bin/playwright-crx-host';
  }

  // Write the configuration
  fs.writeFileSync(targetFile, JSON.stringify(hostConfig, null, 2));
  log(`Native messaging host installed successfully`);
  log(`Extension can now communicate with native apps via: ${hostConfig.name}`);

  return targetFile;
}

function uninstallNativeHost() {
  const nativeHostDir = getNativeHostPath();
  const targetFile = path.join(nativeHostDir, 'com.playwright.crx.host.json');

  if (fs.existsSync(targetFile)) {
    fs.unlinkSync(targetFile);
    log(`Native messaging host uninstalled: ${targetFile}`);
  } else {
    log(`Native messaging host not found: ${targetFile}`);
  }
}

// Command line interface
if (require.main === module) {
  const command = process.argv[2] || 'install';

  try {
    switch (command) {
      case 'install':
        installNativeHost();
        break;
      case 'uninstall':
        uninstallNativeHost();
        break;
      case 'path':
        console.log(getNativeHostPath());
        break;
      default:
        console.log('Usage: node install-native-host.js [install|uninstall|path]');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

module.exports = { installNativeHost, uninstallNativeHost, getNativeHostPath };