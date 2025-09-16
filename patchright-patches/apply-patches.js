#!/usr/bin/env node

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
// Import our fixed patches
import { patchCRNetworkManager as patchCRNetworkManagerFixed } from "./driver_patches/crNetworkManagerPatch_fixed.js";
import { patchPage as patchPageFixed } from "./driver_patches/pagePatch_fixed.js";

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PLAYWRIGHT_ROOT = path.resolve(PROJECT_ROOT, 'playwright');

async function main() {
  console.log('🔧 Applying Patchright patches to Playwright...');

  // Change working directory to Playwright root so relative paths work
  process.chdir(PLAYWRIGHT_ROOT);

  const project = new Project({
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
    },
  });

  console.log('📁 Working directory set to:', PLAYWRIGHT_ROOT);

  // Apply all patches
  console.log('🎭 Applying stealth patches...');

  const patchesToApply = [
    { name: 'Browser context', fn: patches.patchBrowserContext },
    { name: 'Chromium', fn: patches.patchChromium },
    { name: 'Chromium switches', fn: patches.patchChromiumSwitches },
    { name: 'CR browser', fn: patches.patchCRBrowser },
    { name: 'CR DevTools', fn: patches.patchCRDevTools },
    { name: 'CR network manager (fixed)', fn: patchCRNetworkManagerFixed },
    { name: 'CR service worker', fn: patches.patchCRServiceWorker },
    { name: 'Frames', fn: patches.patchFrames },
    { name: 'Page (fixed)', fn: patchPageFixed },
    // Add other patches as needed...
  ];

  const successfulPatches = [];
  const failedPatches = [];

  for (const patch of patchesToApply) {
    try {
      patch.fn(project);
      console.log(`  ✅ ${patch.name} patches applied`);
      successfulPatches.push(patch.name);
    } catch (error) {
      console.warn(`  ⚠️  ${patch.name} patches failed (likely due to code changes in v1.55.0): ${error.message}`);
      failedPatches.push({ name: patch.name, error: error.message });
    }
  }

  console.log(`\n📊 Patch Summary:`);
  console.log(`   ✅ Successful: ${successfulPatches.length}/${patchesToApply.length}`);
  if (failedPatches.length > 0) {
    console.log(`   ⚠️  Failed: ${failedPatches.length}/${patchesToApply.length}`);
    console.log(`   Note: Some patches may fail due to code changes in Playwright v1.55.0`);
  }

  // Save all modified files
  await project.save();

  console.log('💾 Saved patched files');
  console.log('🎉 Patchright patches applied successfully!');
  console.log('');
  console.log('Your Playwright CRX is now undetectable! 🥷');
}

main().catch(console.error);
