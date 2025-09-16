#!/usr/bin/env node

/**
 * Script to apply Patchright patches to Playwright CRX
 * This makes the CRX undetectable by anti-bot systems
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PATCHRIGHT_ROOT = path.resolve(PROJECT_ROOT, '..', 'patchright');
const PLAYWRIGHT_ROOT = path.resolve(PROJECT_ROOT, 'playwright');

async function main() {
  console.log('🎭 Applying Patchright patches to Playwright CRX...');

  // Check if Patchright exists
  try {
    await fs.access(PATCHRIGHT_ROOT);
    console.log('✅ Found Patchright at:', PATCHRIGHT_ROOT);
  } catch (error) {
    console.error('❌ Patchright not found at:', PATCHRIGHT_ROOT);
    console.error('Please ensure Patchright is cloned in the parent directory');
    process.exit(1);
  }

  // Check if we have a Playwright subtree
  try {
    await fs.access(path.join(PLAYWRIGHT_ROOT, 'package.json'));
    console.log('✅ Found Playwright subtree at:', PLAYWRIGHT_ROOT);
  } catch (error) {
    console.error('❌ Playwright subtree not found at:', PLAYWRIGHT_ROOT);
    process.exit(1);
  }

  // Copy Patchright patches to our project
  const patchesDir = path.join(PROJECT_ROOT, 'patchright-patches');
  try {
    await fs.rm(patchesDir, { recursive: true, force: true });
  } catch (error) {
    // Directory might not exist, that's okay
  }

  await fs.mkdir(patchesDir, { recursive: true });

  // Copy the entire driver_patches directory
  await copyDirectory(
    path.join(PATCHRIGHT_ROOT, 'driver_patches'),
    path.join(patchesDir, 'driver_patches')
  );

  // Copy the main patch script
  await fs.copyFile(
    path.join(PATCHRIGHT_ROOT, 'patchright_driver_patch.js'),
    path.join(patchesDir, 'patchright_driver_patch.js')
  );

  // Copy package.json for dependencies
  await fs.copyFile(
    path.join(PATCHRIGHT_ROOT, 'package.json'),
    path.join(patchesDir, 'package.json')
  );

  console.log('✅ Copied Patchright patches to:', patchesDir);

  // Create our integration script
  await createIntegrationScript(patchesDir);

  console.log('🎉 Patchright integration setup complete!');
  console.log('');
  console.log('Next steps:');
  console.log('1. Run: npm install --prefix ./patchright-patches');
  console.log('2. Run: npm run apply-patchright');
  console.log('3. Rebuild: npm run build');
}

async function copyDirectory(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function createIntegrationScript(patchesDir) {
  const integrationScript = `#!/usr/bin/env node

/**
 * Apply Patchright patches to Playwright CRX
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Project, SyntaxKind, IndentationText } from "ts-morph";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import Patchright patches
import * as patches from "./driver_patches/index.js";

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PLAYWRIGHT_ROOT = path.resolve(PROJECT_ROOT, 'playwright');

async function main() {
  console.log('🔧 Applying Patchright patches to Playwright...');

  const project = new Project({
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
    },
    tsConfigFilePath: path.join(PLAYWRIGHT_ROOT, 'tsconfig.json'),
  });

  // Add Playwright source files to the project
  project.addSourceFilesAtPaths(path.join(PLAYWRIGHT_ROOT, 'packages/playwright-core/src/**/*.ts'));

  console.log('📁 Loaded Playwright source files');

  // Apply all patches
  console.log('🎭 Applying stealth patches...');

  try {
    patches.patchBrowserContext(project);
    console.log('  ✅ Browser context patches applied');

    patches.patchChromium(project);
    console.log('  ✅ Chromium patches applied');

    patches.patchChromiumSwitches(project);
    console.log('  ✅ Chromium switches patches applied');

    patches.patchCRBrowser(project);
    console.log('  ✅ CR browser patches applied');

    patches.patchCRDevTools(project);
    console.log('  ✅ CR DevTools patches applied');

    patches.patchCRNetworkManager(project);
    console.log('  ✅ CR network manager patches applied');

    patches.patchCRServiceWorker(project);
    console.log('  ✅ CR service worker patches applied');

    patches.patchFrames(project);
    console.log('  ✅ Frames patches applied');

    patches.patchPage(project);
    console.log('  ✅ Page patches applied');

    // Apply other patches as needed...

  } catch (error) {
    console.error('❌ Error applying patches:', error);
    process.exit(1);
  }

  // Save all modified files
  await project.save();

  console.log('💾 Saved patched files');
  console.log('🎉 Patchright patches applied successfully!');
  console.log('');
  console.log('Your Playwright CRX is now undetectable! 🥷');
}

main().catch(console.error);
`;

  await fs.writeFile(path.join(patchesDir, 'apply-patches.js'), integrationScript);
  await fs.chmod(path.join(patchesDir, 'apply-patches.js'), 0o755);
}

main().catch(console.error);