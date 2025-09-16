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

import './shims/global';

import './protocol/validator';

import { DispatcherConnection, RootDispatcher } from 'playwright-core/lib/server';
import { CrxConnection } from './client/crxConnection';
import type { CrxPlaywright as CrxPlaywrightAPI } from './client/crxPlaywright';
import { CrxPlaywright } from './server/crxPlaywright';
import { CrxPlaywrightDispatcher } from './server/dispatchers/crxPlaywrightDispatcher';
import { PageBinding } from 'playwright-core/lib/server/page';

import { wrapClientApis } from './client/crxZone';
import { nodePlatform } from 'playwright-core/lib/utils';

export { debug as _debug } from 'debug';
export { isUnderTest as _isUnderTest } from 'playwright-core/lib/utils';

// setUnderTest was removed in newer Playwright versions - now controlled via PWTEST_UNDER_TEST env var
export const _setUnderTest = (value: boolean) => {
  process.env.PWTEST_UNDER_TEST = value ? '1' : '0';
};

// avoid conflicts with playwright when testing
PageBinding.kBindingName = '__crx__binding__';

// Lazy initialization to avoid browser executable path issues during module loading
let playwrightAPI: CrxPlaywrightAPI | null = null;

function initializePlaywright() {
  if (playwrightAPI)
    return playwrightAPI;

  const playwright = new CrxPlaywright();

  const clientConnection = new CrxConnection(nodePlatform);
  const dispatcherConnection = new DispatcherConnection(true /* local */);

  // Dispatch synchronously at first.
  dispatcherConnection.onmessage = message => clientConnection.dispatch(message);
  clientConnection.onmessage = message => dispatcherConnection.dispatch(message);

  const rootScope = new RootDispatcher(dispatcherConnection);

  // Initialize Playwright channel.
  new CrxPlaywrightDispatcher(rootScope, playwright);
  playwrightAPI = clientConnection.getObjectWithKnownName('Playwright') as CrxPlaywrightAPI;

  // Switch to async dispatch after we got Playwright object.
  dispatcherConnection.onmessage = message => setImmediate(() => clientConnection.dispatch(message));
  clientConnection.onmessage = message => setImmediate(() => dispatcherConnection.dispatch(message));

  clientConnection.toImpl = (x: any) => x ? dispatcherConnection._dispatcherByGuid.get(x._guid)!._object : dispatcherConnection._dispatcherByGuid.get('');
  (playwrightAPI as any)._toImpl = clientConnection.toImpl;

  return playwrightAPI;
}

// Create a proxy object that initializes Playwright on first access
export const crx = new Proxy({} as any, {
  get(target, prop) {
    const api = initializePlaywright();
    return api._crx[prop];
  }
});

export const selectors = new Proxy({} as any, {
  get(target, prop) {
    const api = initializePlaywright();
    return api.selectors[prop];
  }
});

export const errors = new Proxy({} as any, {
  get(target, prop) {
    const api = initializePlaywright();
    return api.errors[prop];
  }
});
export default playwrightAPI;

wrapClientApis();
