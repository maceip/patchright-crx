#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXAMPLES_DIR = path.join(PROJECT_ROOT, 'examples');
const BUILD_DIR = path.join(PROJECT_ROOT, 'build');
const PRIVATE_KEY_PATH = path.join(PROJECT_ROOT, 'extension-key.pem');

async function execAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      ...options
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}: ${command} ${args.join(' ')}`));
      }
    });
  });
}

async function buildCrx(extensionName) {
  const extensionDir = path.join(EXAMPLES_DIR, extensionName);
  const distDir = path.join(extensionDir, 'dist');
  const crxPath = path.join(BUILD_DIR, `${extensionName}.crx`);
  const updateManifestPath = path.join(BUILD_DIR, `${extensionName}-update.xml`);

  console.log(`Building CRX for ${extensionName}...`);

  // Ensure dist directory exists
  if (!fs.existsSync(distDir)) {
    console.error(`Distribution directory not found: ${distDir}`);
    console.log('Please run the build process first (e.g., npm run build)');
    process.exit(1);
  }

  // Ensure build directory exists
  if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
  }

  // Ensure private key exists
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    console.error(`Private key not found: ${PRIVATE_KEY_PATH}`);
    console.log('Please generate a private key first with: openssl genrsa -out extension-key.pem 2048');
    process.exit(1);
  }

  // Read manifest to get version and extension ID
  const manifestPath = path.join(distDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = manifest.version;

  // Generate extension ID from public key
  const publicKeyBuffer = await getPublicKeyFromPrivateKey(PRIVATE_KEY_PATH);
  const extensionId = generateExtensionId(publicKeyBuffer);

  console.log(`Extension ID: ${extensionId}`);
  console.log(`Version: ${version}`);

  try {
    // Use Chrome to pack the extension
    const chromePath = findChrome();
    if (!chromePath) {
      throw new Error('Chrome not found. Please install Chrome to build CRX files.');
    }

    await execAsync(`"${chromePath}"`, [
      `--pack-extension="${distDir}"`,
      `--pack-extension-key="${PRIVATE_KEY_PATH}"`
    ]);

    // Chrome creates the CRX in the parent directory of the extension
    const generatedCrxPath = distDir + '.crx';
    if (fs.existsSync(generatedCrxPath)) {
      // Move to build directory
      fs.renameSync(generatedCrxPath, crxPath);
      console.log(`CRX created: ${crxPath}`);
    } else {
      throw new Error('Chrome failed to generate CRX file');
    }

    // Generate update manifest
    const updateManifest = generateUpdateManifest(extensionId, version, path.basename(crxPath));
    fs.writeFileSync(updateManifestPath, updateManifest);
    console.log(`Update manifest created: ${updateManifestPath}`);

    return {
      crxPath,
      updateManifestPath,
      extensionId,
      version
    };

  } catch (error) {
    console.error('Failed to build CRX:', error.message);
    process.exit(1);
  }
}

function findChrome() {
  const possiblePaths = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/chrome'
    ]
  };

  const platform = process.platform;
  const paths = possiblePaths[platform] || possiblePaths.linux;

  for (const chromePath of paths) {
    if (fs.existsSync(chromePath)) {
      return chromePath;
    }
  }

  return null;
}

async function getPublicKeyFromPrivateKey(privateKeyPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('openssl', [
      'rsa', '-in', privateKeyPath, '-pubout', '-outform', 'DER'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let output = Buffer.alloc(0);
    proc.stdout.on('data', (data) => {
      output = Buffer.concat([output, data]);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error('Failed to extract public key'));
      }
    });
  });
}

function generateExtensionId(publicKeyBuffer) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(publicKeyBuffer).digest();

  // Take first 16 bytes and encode as hexadecimal, then map to a-p
  const hexString = hash.subarray(0, 16).toString('hex');
  return hexString.split('').map(char => {
    const code = parseInt(char, 16);
    return String.fromCharCode(97 + code); // 'a' + code
  }).join('');
}

function generateUpdateManifest(extensionId, version, crxFilename) {
  return `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${extensionId}'>
    <updatecheck codebase='${crxFilename}' version='${version}' />
  </app>
</gupdate>`;
}

// Main execution
if (require.main === module) {
  const extensionName = process.argv[2] || 'nativerelay-crx';

  console.log(`Building CRX package for ${extensionName}...`);

  buildCrx(extensionName)
    .then(result => {
      console.log('Build completed successfully!');
      console.log('Files generated:');
      console.log(`  CRX: ${result.crxPath}`);
      console.log(`  Update manifest: ${result.updateManifestPath}`);
      console.log(`  Extension ID: ${result.extensionId}`);
    })
    .catch(error => {
      console.error('Build failed:', error);
      process.exit(1);
    });
}

module.exports = { buildCrx };