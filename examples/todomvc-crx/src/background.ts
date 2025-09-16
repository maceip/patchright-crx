/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createTodos } from './todos';

chrome.action.onClicked.addListener(async ({ id: tabId }) => {
  await chrome.action.disable();

  try {
    // Dynamically importing playwright-crx...
    const { crx } = await import('playwright-crx');
    // Starting CRX...
    const crxApp = await crx.start({ slowMo: 500 });
    // CRX started successfully
    const page = await crxApp.attach(tabId!).catch(() => crxApp.newPage());

    try {
      await page.context().tracing.start({ screenshots: true, snapshots: true });
      await createTodos(page);
      await page.context().tracing.stop({ path: '/tmp/trace.zip' });
      const data = crx.fs.readFileSync('/tmp/trace.zip');

      const tracePage = await crxApp.newPage();
      await tracePage.goto('https://trace.playwright.dev');
      const [filechooser] = await Promise.all([
        tracePage.waitForEvent('filechooser'),
        tracePage.getByRole('button', { name: 'Select file(s)' }).click(),
      ]);
      await filechooser.setFiles({
        name: 'trace.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(data),
      });
      await crxApp.detach(tracePage);
    } finally {
      await crxApp.close();
    }
  } catch (error) {
    // CRX Error: ${error}
    // Error stack: ${(error as Error).stack}
  } finally {
    await chrome.action.enable();
  }
});
