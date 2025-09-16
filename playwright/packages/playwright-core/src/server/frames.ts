// patchright - custom imports
import { CRExecutionContext } from './chromium/crExecutionContext';
import { FrameExecutionContext } from './dom';
import crypto from 'crypto';
/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { BrowserContext } from './browserContext';
import * as dom from './dom';
import { TimeoutError } from './errors';
import { prepareFilesForUpload } from './fileUploadUtils';
import { FrameSelectors } from './frameSelectors';
import { helper } from './helper';
import { SdkObject } from './instrumentation';
import * as js from './javascript';
import * as network from './network';
import { Page } from './page';
import { isAbortError, ProgressController } from './progress';
import * as types from './types';
import { LongStandingScope, asLocator, assert, constructURLBasedOnBaseURL, makeWaitForNextTask, renderTitleForCall } from '../utils';
import { isSessionClosedError } from './protocolError';
import { debugLogger } from './utils/debugLogger';
import { eventsHelper } from './utils/eventsHelper';
import {  isInvalidSelectorError } from '../utils/isomorphic/selectorParser';
import { ManualPromise } from '../utils/isomorphic/manualPromise';
import { compressCallLog } from './callLog';

import type { ConsoleMessage } from './console';
import type { ElementStateWithoutStable, FrameExpectParams, InjectedScript } from '@injected/injectedScript';
import type { Progress } from './progress';
import type { ScreenshotOptions } from './screenshotter';
import type { RegisteredListener } from './utils/eventsHelper';
import type { ParsedSelector } from '../utils/isomorphic/selectorParser';
import type * as channels from '@protocol/channels';

type ContextData = {
  contextPromise: ManualPromise<dom.FrameExecutionContext | { destroyedReason: string }>;
  context: dom.FrameExecutionContext | null;
};

type DocumentInfo = {
  // Unfortunately, we don't have documentId when we find out about
  // a pending navigation from things like frameScheduledNavigaiton.
  documentId: string | undefined,
  request: network.Request | undefined,
};

export type GotoResult = {
  newDocumentId?: string,
};

type ConsoleTagHandler = () => void;

type RegularLifecycleEvent = Exclude<types.LifecycleEvent, 'networkidle'>;

export type FunctionWithSource = (source: { context: BrowserContext, page: Page, frame: Frame}, ...args: any) => any;

export type NavigationEvent = {
  // New frame url after navigation.
  url: string,
  // New frame name after navigation.
  name: string,
  // Information about the new document for cross-document navigations.
  // Undefined for same-document navigations.
  newDocument?: DocumentInfo,
  // Error for cross-document navigations if any. When error is present,
  // the navigation did not commit.
  error?: Error,
  // Whether this event should be visible to the clients via the public APIs.
  isPublic?: boolean;
};

type ElementCallback<T, R> = (injected: InjectedScript, element: Element, data: T) => R;

export class NavigationAbortedError extends Error {
  readonly documentId?: string;
  constructor(documentId: string | undefined, message: string) {
    super(message);
    this.documentId = documentId;
  }
}

type ExpectResult = { matches: boolean, received?: any, log?: string[], timedOut?: boolean };

const kDummyFrameId = '<dummy>';

export class FrameManager {
  private _page: Page;
  private _frames = new Map<string, Frame>();
  private _mainFrame: Frame;
  readonly _consoleMessageTags = new Map<string, ConsoleTagHandler>();
  readonly _signalBarriers = new Set<SignalBarrier>();
  private _webSockets = new Map<string, network.WebSocket>();

  constructor(page: Page) {
    this._page = page;
    this._mainFrame = undefined as any as Frame;
  }

  createDummyMainFrameIfNeeded() {
    if (!this._mainFrame)
      this.frameAttached(kDummyFrameId, null);
  }

  dispose() {
    for (const frame of this._frames.values()) {
      frame._stopNetworkIdleTimer();
      frame._invalidateNonStallingEvaluations('Target crashed');
    }
  }

  mainFrame(): Frame {
    return this._mainFrame;
  }

  frames() {
    const frames: Frame[] = [];
    collect(this._mainFrame);
    return frames;

    function collect(frame: Frame) {
      frames.push(frame);
      for (const subframe of frame.childFrames())
        collect(subframe);
    }
  }

  frame(frameId: string): Frame | null {
    return this._frames.get(frameId) || null;
  }

  frameAttached(frameId: string, parentFrameId: string | null | undefined): Frame {
    const parentFrame = parentFrameId ? this._frames.get(parentFrameId)! : null;
    if (!parentFrame) {
      if (this._mainFrame) {
        // Update frame id to retain frame identity on cross-process navigation.
        this._frames.delete(this._mainFrame._id);
        this._mainFrame._id = frameId;
      } else {
        assert(!this._frames.has(frameId));
        this._mainFrame = new Frame(this._page, frameId, parentFrame);
      }
      this._frames.set(frameId, this._mainFrame);
      return this._mainFrame;
    } else {
      assert(!this._frames.has(frameId));
      const frame = new Frame(this._page, frameId, parentFrame);
      this._frames.set(frameId, frame);
      this._page.emit(Page.Events.FrameAttached, frame);
      return frame;
    }
  }

  async waitForSignalsCreatedBy<T>(progress: Progress, waitAfter: boolean, action: () => Promise<T>): Promise<T> {
    if (!waitAfter)
      return action();
    const barrier = new SignalBarrier(progress);
    this._signalBarriers.add(barrier);
    try {
      const result = await action();
      await progress.race(this._page.delegate.inputActionEpilogue());
      await barrier.waitFor();
      // Resolve in the next task, after all waitForNavigations.
      await new Promise<void>(makeWaitForNextTask());
      return result;
    } finally {
      this._signalBarriers.delete(barrier);
    }
  }

  frameWillPotentiallyRequestNavigation() {
    for (const barrier of this._signalBarriers)
      barrier.retain();
  }

  frameDidPotentiallyRequestNavigation() {
    for (const barrier of this._signalBarriers)
      barrier.release();
  }

  frameRequestedNavigation(frameId: string, documentId?: string) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    for (const barrier of this._signalBarriers)
      barrier.addFrameNavigation(frame);
    if (frame.pendingDocument() && frame.pendingDocument()!.documentId === documentId) {
      // Do not override request with undefined.
      return;
    }

    const request = documentId ? Array.from(frame._inflightRequests).find(request => request._documentId === documentId) : undefined;
    frame.setPendingDocument({ documentId, request });
  }

  frameCommittedNewDocumentNavigation(frameId: string, url: string, name: string, documentId: string, initial: boolean) {
    const frame = this._frames.get(frameId)!;
    this.removeChildFramesRecursively(frame);
    this.clearWebSockets(frame);
    frame._url = url;
    frame._name = name;

    let keepPending: DocumentInfo | undefined;
    const pendingDocument = frame.pendingDocument();
    if (pendingDocument) {
      if (pendingDocument.documentId === undefined) {
        // Pending with unknown documentId - assume it is the one being committed.
        pendingDocument.documentId = documentId;
      }
      if (pendingDocument.documentId === documentId) {
        // Committing a pending document.
        frame._currentDocument = pendingDocument;
      } else {
        // Sometimes, we already have a new pending when the old one commits.
        // An example would be Chromium error page followed by a new navigation request,
        // where the error page commit arrives after Network.requestWillBeSent for the
        // new navigation.
        // We commit, but keep the pending request since it's not done yet.
        keepPending = pendingDocument;
        frame._currentDocument = { documentId, request: undefined };
      }
      frame.setPendingDocument(undefined);
    } else {
      // No pending - just commit a new document.
      frame._currentDocument = { documentId, request: undefined };
    }

    frame._onClearLifecycle();
    const navigationEvent: NavigationEvent = { url, name, newDocument: frame._currentDocument, isPublic: true };
    this._fireInternalFrameNavigation(frame, navigationEvent);
    if (!initial) {
      debugLogger.log('api', `  navigated to "${url}"`);
      this._page.frameNavigatedToNewDocument(frame);
    }
    // Restore pending if any - see comments above about keepPending.
    frame.setPendingDocument(keepPending);
  }

  frameCommittedSameDocumentNavigation(frameId: string, url: string) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    const pending = frame.pendingDocument();
    if (pending && pending.documentId === undefined && pending.request === undefined) {
      // WebKit has notified about the same-document navigation being requested, so clear it.
      frame.setPendingDocument(undefined);
    }
    frame._url = url;
    const navigationEvent: NavigationEvent = { url, name: frame._name, isPublic: true };
    this._fireInternalFrameNavigation(frame, navigationEvent);
    debugLogger.log('api', `  navigated to "${url}"`);
  }

  frameAbortedNavigation(frameId: string, errorText: string, documentId?: string) {
    const frame = this._frames.get(frameId);
    if (!frame || !frame.pendingDocument())
      return;
    if (documentId !== undefined && frame.pendingDocument()!.documentId !== documentId)
      return;
    const navigationEvent: NavigationEvent = {
      url: frame._url,
      name: frame._name,
      newDocument: frame.pendingDocument(),
      error: new NavigationAbortedError(documentId, errorText),
      isPublic: !(documentId && frame._redirectedNavigations.has(documentId)),
    };
    frame.setPendingDocument(undefined);
    this._fireInternalFrameNavigation(frame, navigationEvent);
  }

  frameDetached(frameId: string) {
    const frame = this._frames.get(frameId);
    if (frame) {
      this._removeFramesRecursively(frame);
      this._page.mainFrame()._recalculateNetworkIdle();
    }
  }

  frameLifecycleEvent(frameId: string, event: RegularLifecycleEvent) {
    const frame = this._frames.get(frameId);
    if (frame)
      frame._onLifecycleEvent(event);
  }

  requestStarted(request: network.Request, route?: network.RouteDelegate) {
    const frame = request.frame()!;
    this._inflightRequestStarted(request);
    if (request._documentId)
      frame.setPendingDocument({ documentId: request._documentId, request });
    if (request._isFavicon) {
      // Abort favicon requests to avoid network access in case of interception.
      route?.abort('aborted').catch(() => {});
      return;
    }
    this._page.emitOnContext(BrowserContext.Events.Request, request);
    if (route)
      new network.Route(request, route).handle([...this._page.requestInterceptors, ...this._page.browserContext.requestInterceptors]);
  }

  requestReceivedResponse(response: network.Response) {
    if (response.request()._isFavicon)
      return;
    this._page.emitOnContext(BrowserContext.Events.Response, response);
  }

  reportRequestFinished(request: network.Request, response: network.Response | null) {
    this._inflightRequestFinished(request);
    if (request._isFavicon)
      return;
    this._page.emitOnContext(BrowserContext.Events.RequestFinished, { request, response });
  }

  requestFailed(request: network.Request, canceled: boolean) {
    const frame = request.frame()!;
    this._inflightRequestFinished(request);
    if (frame.pendingDocument() && frame.pendingDocument()!.request === request) {
      let errorText = request.failure()!.errorText;
      if (canceled)
        errorText += '; maybe frame was detached?';
      this.frameAbortedNavigation(frame._id, errorText, frame.pendingDocument()!.documentId);
    }
    if (request._isFavicon)
      return;
    this._page.emitOnContext(BrowserContext.Events.RequestFailed, request);
  }

  removeChildFramesRecursively(frame: Frame) {
    for (const child of frame.childFrames())
      this._removeFramesRecursively(child);
  }

  private _removeFramesRecursively(frame: Frame) {
    this.removeChildFramesRecursively(frame);
    frame._onDetached();
    this._frames.delete(frame._id);
    if (!this._page.isClosed())
      this._page.emit(Page.Events.FrameDetached, frame);
  }

  private _inflightRequestFinished(request: network.Request) {
    const frame = request.frame()!;
    if (request._isFavicon)
      return;
    if (!frame._inflightRequests.has(request))
      return;
    frame._inflightRequests.delete(request);
    if (frame._inflightRequests.size === 0)
      frame._startNetworkIdleTimer();
  }

  private _inflightRequestStarted(request: network.Request) {
    const frame = request.frame()!;
    if (request._isFavicon)
      return;
    frame._inflightRequests.add(request);
    if (frame._inflightRequests.size === 1)
      frame._stopNetworkIdleTimer();
  }

  interceptConsoleMessage(message: ConsoleMessage): boolean {
    if (message.type() !== 'debug')
      return false;
    const tag = message.text();
    const handler = this._consoleMessageTags.get(tag);
    if (!handler)
      return false;
    this._consoleMessageTags.delete(tag);
    handler();
    return true;
  }

  clearWebSockets(frame: Frame) {
    // TODO: attribute sockets to frames.
    if (frame.parentFrame())
      return;
    this._webSockets.clear();
  }

  onWebSocketCreated(requestId: string, url: string) {
    const ws = new network.WebSocket(this._page, url);
    this._webSockets.set(requestId, ws);
  }

  onWebSocketRequest(requestId: string) {
    const ws = this._webSockets.get(requestId);
    if (ws && ws.markAsNotified())
      this._page.emit(Page.Events.WebSocket, ws);
  }

  onWebSocketResponse(requestId: string, status: number, statusText: string) {
    const ws = this._webSockets.get(requestId);
    if (status < 400)
      return;
    if (ws)
      ws.error(`${statusText}: ${status}`);
  }

  onWebSocketFrameSent(requestId: string, opcode: number, data: string) {
    const ws = this._webSockets.get(requestId);
    if (ws)
      ws.frameSent(opcode, data);
  }

  webSocketFrameReceived(requestId: string, opcode: number, data: string) {
    const ws = this._webSockets.get(requestId);
    if (ws)
      ws.frameReceived(opcode, data);
  }

  webSocketClosed(requestId: string) {
    const ws = this._webSockets.get(requestId);
    if (ws)
      ws.closed();
    this._webSockets.delete(requestId);
  }

  webSocketError(requestId: string, errorMessage: string): void {
    const ws = this._webSockets.get(requestId);
    if (ws)
      ws.error(errorMessage);
  }

  private _fireInternalFrameNavigation(frame: Frame, event: NavigationEvent) {
    frame.emit(Frame.Events.InternalNavigation, event);
  }
}

export class Frame extends SdkObject {
  static Events = {
    InternalNavigation: 'internalnavigation',
    AddLifecycle: 'addlifecycle',
    RemoveLifecycle: 'removelifecycle',
  };

  _id: string;
  _firedLifecycleEvents = new Set<types.LifecycleEvent>();
  private _firedNetworkIdleSelf = false;
  _currentDocument: DocumentInfo;
  private _pendingDocument: DocumentInfo | undefined;
  readonly _page: Page;
  private _parentFrame: Frame | null;
  _url = '';
  private _contextData = new Map<types.World, ContextData>();
  private _childFrames = new Set<Frame>();
  _name = '';
  _inflightRequests = new Set<network.Request>();
  private _networkIdleTimer: NodeJS.Timeout | undefined;
  private _setContentCounter = 0;
  readonly _detachedScope = new LongStandingScope();
  private _raceAgainstEvaluationStallingEventsPromises = new Set<ManualPromise<any>>();
  readonly _redirectedNavigations = new Map<string, { url: string, gotoPromise: Promise<network.Response | null> }>(); // documentId -> data
  readonly selectors: FrameSelectors;

  constructor(page: Page, id: string, parentFrame: Frame | null) {
    super(page, 'frame');
    this.attribution.frame = this;
    this._id = id;
    this._page = page;
    this._parentFrame = parentFrame;
    this._currentDocument = { documentId: undefined, request: undefined };
    this.selectors = new FrameSelectors(this);

    this._contextData.set('main', { contextPromise: new ManualPromise(), context: null });
    this._contextData.set('utility', { contextPromise: new ManualPromise(), context: null });
    this._setContext('main', null);
    this._setContext('utility', null);

    if (this._parentFrame)
      this._parentFrame._childFrames.add(this);

    this._firedLifecycleEvents.add('commit');
    if (id !== kDummyFrameId)
      this._startNetworkIdleTimer();
  }

  isDetached(): boolean {
    return this._detachedScope.isClosed();
  }

  _onLifecycleEvent(event: RegularLifecycleEvent) {
    if (this._firedLifecycleEvents.has(event))
      return;
    this._firedLifecycleEvents.add(event);
    this.emit(Frame.Events.AddLifecycle, event);
    if (this === this._page.mainFrame() && this._url !== 'about:blank')
      debugLogger.log('api', `  "${event}" event fired`);
    this._page.mainFrame()._recalculateNetworkIdle();
  }

  _onClearLifecycle() {
    this._isolatedWorld = undefined;
    this._mainWorld = undefined;
    this._iframeWorld = undefined;
    for (const event of this._firedLifecycleEvents)
      this.emit(Frame.Events.RemoveLifecycle, event);
    this._firedLifecycleEvents.clear();
    // Keep the current navigation request if any.
    this._inflightRequests = new Set(Array.from(this._inflightRequests).filter(request => request === this._currentDocument.request));
    this._stopNetworkIdleTimer();
    if (this._inflightRequests.size === 0)
      this._startNetworkIdleTimer();
    this._page.mainFrame()._recalculateNetworkIdle(this);
    this._onLifecycleEvent('commit');
  }

  setPendingDocument(documentInfo: DocumentInfo | undefined) {
    this._pendingDocument = documentInfo;
    if (documentInfo)
      this._invalidateNonStallingEvaluations('Navigation interrupted the evaluation');
  }

  pendingDocument(): DocumentInfo | undefined {
    return this._pendingDocument;
  }

  _invalidateNonStallingEvaluations(message: string) {
    if (!this._raceAgainstEvaluationStallingEventsPromises.size)
      return;
    const error = new Error(message);
    for (const promise of this._raceAgainstEvaluationStallingEventsPromises)
      promise.reject(error);
  }

  async raceAgainstEvaluationStallingEvents<T>(cb: () => Promise<T>): Promise<T> {
    if (this._pendingDocument)
      throw new Error('Frame is currently attempting a navigation');
    if (this._page.browserContext.dialogManager.hasOpenDialogsForPage(this._page))
      throw new Error('Open JavaScript dialog prevents evaluation');

    const promise = new ManualPromise<T>();
    this._raceAgainstEvaluationStallingEventsPromises.add(promise);
    try {
      return await Promise.race([
        cb(),
        promise
      ]);
    } finally {
      this._raceAgainstEvaluationStallingEventsPromises.delete(promise);
    }
  }

  nonStallingRawEvaluateInExistingMainContext(expression: string): Promise<any> {
    return this.raceAgainstEvaluationStallingEvents(() => {
      const context = this._existingMainContext();
      if (!context)
        throw new Error('Frame does not yet have a main execution context');
      return context.rawEvaluateJSON(expression);
    });
  }

  nonStallingEvaluateInExistingContext(expression: string, world: types.World): Promise<any> {
    return this.raceAgainstEvaluationStallingEvents(() => {
      const context = this._contextData.get(world)?.context;
      if (!context)
        throw new Error('Frame does not yet have the execution context');
      return context.evaluateExpression(expression, { isFunction: false });
    });
  }

  _recalculateNetworkIdle(frameThatAllowsRemovingNetworkIdle?: Frame) {
    let isNetworkIdle = this._firedNetworkIdleSelf;
    for (const child of this._childFrames) {
      child._recalculateNetworkIdle(frameThatAllowsRemovingNetworkIdle);
      // We require networkidle event to be fired in the whole frame subtree, and then consider it done.
      if (!child._firedLifecycleEvents.has('networkidle'))
        isNetworkIdle = false;
    }
    if (isNetworkIdle && !this._firedLifecycleEvents.has('networkidle')) {
      this._firedLifecycleEvents.add('networkidle');
      this.emit(Frame.Events.AddLifecycle, 'networkidle');
      if (this === this._page.mainFrame() && this._url !== 'about:blank')
        debugLogger.log('api', `  "networkidle" event fired`);
    }
    if (frameThatAllowsRemovingNetworkIdle !== this && this._firedLifecycleEvents.has('networkidle') && !isNetworkIdle) {
      // Usually, networkidle is fired once and not removed after that.
      // However, when we clear them right before a new commit, this is allowed for a particular frame.
      this._firedLifecycleEvents.delete('networkidle');
      this.emit(Frame.Events.RemoveLifecycle, 'networkidle');
    }
  }

  async raceNavigationAction(progress: Progress, action: () => Promise<network.Response | null>): Promise<network.Response | null> {
    return LongStandingScope.raceMultiple([
      this._detachedScope,
      this._page.openScope,
    ], action().catch(e => {
      if (e instanceof NavigationAbortedError && e.documentId) {
        const data = this._redirectedNavigations.get(e.documentId);
        if (data) {
          progress.log(`waiting for redirected navigation to "${data.url}"`);
          return progress.race(data.gotoPromise);
        }
      }
      throw e;
    }));
  }

  redirectNavigation(url: string, documentId: string, referer: string | undefined) {
    const controller = new ProgressController();
    const data = {
      url,
      gotoPromise: controller.run(progress => this.gotoImpl(progress, url, { referer }), 0),
    };
    this._redirectedNavigations.set(documentId, data);
    data.gotoPromise.finally(() => this._redirectedNavigations.delete(documentId));
  }

  async goto(progress: Progress, url: string, options: types.GotoOptions = {}): Promise<network.Response | null> {
    const constructedNavigationURL = constructURLBasedOnBaseURL(this._page.browserContext._options.baseURL, url);
    return this.raceNavigationAction(progress, async () => this.gotoImpl(progress, constructedNavigationURL, options));
  }

  async gotoImpl(progress: Progress, url: string, options: types.GotoOptions): Promise<network.Response | null> {
    const waitUntil = verifyLifecycle('waitUntil', options.waitUntil === undefined ? 'load' : options.waitUntil);
    progress.log(`navigating to "${url}", waiting until "${waitUntil}"`);
    const headers = this._page.extraHTTPHeaders() || [];
    const refererHeader = headers.find(h => h.name.toLowerCase() === 'referer');
    let referer = refererHeader ? refererHeader.value : undefined;
    if (options.referer !== undefined) {
      if (referer !== undefined && referer !== options.referer)
        throw new Error('"referer" is already specified as extra HTTP header');
      referer = options.referer;
    }
    url = helper.completeUserURL(url);

    const navigationEvents: NavigationEvent[] = [];
    const collectNavigations = (arg: NavigationEvent) => navigationEvents.push(arg);
    this.on(Frame.Events.InternalNavigation, collectNavigations);
    const navigateResult = await progress.race(this._page.delegate.navigateFrame(this, url, referer)).finally(
        () => this.off(Frame.Events.InternalNavigation, collectNavigations));

    let event: NavigationEvent;
    if (navigateResult.newDocumentId) {
      const predicate = (event: NavigationEvent) => {
        // We are interested either in this specific document, or any other document that
        // did commit and replaced the expected document.
        return event.newDocument && (event.newDocument.documentId === navigateResult.newDocumentId || !event.error);
      };
      const events = navigationEvents.filter(predicate);
      if (events.length)
        event = events[0];
      else
        event = await helper.waitForEvent(progress, this, Frame.Events.InternalNavigation, predicate).promise;
      if (event.newDocument!.documentId !== navigateResult.newDocumentId) {
        // This is just a sanity check. In practice, new navigation should
        // cancel the previous one and report "request cancelled"-like error.
        throw new NavigationAbortedError(navigateResult.newDocumentId, `Navigation to "${url}" is interrupted by another navigation to "${event.url}"`);
      }
      if (event.error)
        throw event.error;
    } else {
      // Wait for same document navigation.
      const predicate = (e: NavigationEvent) => !e.newDocument;
      const events = navigationEvents.filter(predicate);
      if (events.length)
        event = events[0];
      else
        event = await helper.waitForEvent(progress, this, Frame.Events.InternalNavigation, predicate).promise;
    }

    if (!this._firedLifecycleEvents.has(waitUntil))
      await helper.waitForEvent(progress, this, Frame.Events.AddLifecycle, (e: types.LifecycleEvent) => e === waitUntil).promise;

    const request = event.newDocument ? event.newDocument.request : undefined;
    const response = request ? progress.race(request._finalRequest().response()) : null;
    return response;
  }

  async _waitForNavigation(progress: Progress, requiresNewDocument: boolean, options: types.NavigateOptions): Promise<network.Response | null> {
    const waitUntil = verifyLifecycle('waitUntil', options.waitUntil === undefined ? 'load' : options.waitUntil);
    progress.log(`waiting for navigation until "${waitUntil}"`);

    const navigationEvent: NavigationEvent = await helper.waitForEvent(progress, this, Frame.Events.InternalNavigation, (event: NavigationEvent) => {
      // Any failed navigation results in a rejection.
      if (event.error)
        return true;
      if (requiresNewDocument && !event.newDocument)
        return false;
      progress.log(`  navigated to "${this._url}"`);
      return true;
    }).promise;
    if (navigationEvent.error)
      throw navigationEvent.error;

    if (!this._firedLifecycleEvents.has(waitUntil))
      await helper.waitForEvent(progress, this, Frame.Events.AddLifecycle, (e: types.LifecycleEvent) => e === waitUntil).promise;

    const request = navigationEvent.newDocument ? navigationEvent.newDocument.request : undefined;
    return request ? progress.race(request._finalRequest().response()) : null;
  }

  async _waitForLoadState(progress: Progress, state: types.LifecycleEvent): Promise<void> {
    const waitUntil = verifyLifecycle('state', state);
    if (!this._firedLifecycleEvents.has(waitUntil))
      await helper.waitForEvent(progress, this, Frame.Events.AddLifecycle, (e: types.LifecycleEvent) => e === waitUntil).promise;
  }

  async frameElement(): Promise<dom.ElementHandle> {
    return this._page.delegate.getFrameElement(this);
  }

  async _context(world: types.World): Promise<dom.FrameExecutionContext> {

          /* await this._page.delegate._mainFrameSession._client._sendMayFail('DOM.enable');
          var globalDoc = await this._page.delegate._mainFrameSession._client._sendMayFail('DOM.getFrameOwner', { frameId: this._id });
          if (globalDoc) {
            await this._page.delegate._mainFrameSession._client._sendMayFail("DOM.resolveNode", { nodeId: globalDoc.nodeId })
          } */

          if (this.isDetached()) throw new Error('Frame was detached');
          try {
            var client = this._page.delegate._sessionForFrame(this)._client
          } catch (e) { var client = this._page.delegate._mainFrameSession._client }
          var iframeExecutionContextId = await this._getFrameMainFrameContextId(client)

          if (world == "main") {
            // Iframe Only
            if (this != this._page.mainFrame() && iframeExecutionContextId && this._iframeWorld == undefined) {
              var executionContextId = iframeExecutionContextId
              var crContext = new CRExecutionContext(client, { id: executionContextId }, this._id)
              this._iframeWorld = new FrameExecutionContext(crContext, this, world)
              this._page.delegate._mainFrameSession._onExecutionContextCreated({
                id: executionContextId, origin: world, name: world, auxData: { isDefault: this === this._page.mainFrame(), type: 'isolated', frameId: this._id }
              })
            } else if (this._mainWorld == undefined) {
              var globalThis = await client._sendMayFail('Runtime.evaluate', {
                expression: "globalThis",
                serializationOptions: { serialization: "idOnly" }
              });
              if (!globalThis) { return }
              var globalThisObjId = globalThis["result"]['objectId']
              var executionContextId = parseInt(globalThisObjId.split('.')[1], 10);

              var crContext = new CRExecutionContext(client, { id: executionContextId }, this._id)
              this._mainWorld = new FrameExecutionContext(crContext, this, world)
              this._page.delegate._mainFrameSession._onExecutionContextCreated({
                id: executionContextId, origin: world, name: world, auxData: { isDefault: this === this._page.mainFrame(), type: 'isolated', frameId: this._id }
              })
            }
          }
          if (world != "main" && this._isolatedWorld == undefined) {
            world = "utility"
            var result = await client._sendMayFail('Page.createIsolatedWorld', {
              frameId: this._id, grantUniveralAccess: true, worldName: world
            });
            if (!result) {
              // if (this.isDetached()) throw new Error("Frame was detached");
              return
            }
            var executionContextId = result.executionContextId
            var crContext = new CRExecutionContext(client, { id: executionContextId }, this._id)
            this._isolatedWorld = new FrameExecutionContext(crContext, this, world)
            this._page.delegate._mainFrameSession._onExecutionContextCreated({
              id: executionContextId, origin: world, name: world, auxData: { isDefault: this === this._page.mainFrame(), type: 'isolated', frameId: this._id }
            })
          }

          if (world != "main") {
            return this._isolatedWorld;
          } else if (this != this._page.mainFrame() && iframeExecutionContextId) {
            return this._iframeWorld;
          } else {
            return this._mainWorld;
          }
  }

  _mainContext(): Promise<dom.FrameExecutionContext> {
    return this._context('main');
  }

  private _existingMainContext(): dom.FrameExecutionContext | null {
    return this._contextData.get('main')?.context || null;
  }

  _utilityContext(): Promise<dom.FrameExecutionContext> {
    return this._context('utility');
  }

  async evaluateExpression(expression: string, options: { isFunction?: boolean, world?: types.World } = {}, arg?: any): Promise<any> {
    const context = await this._context(options.world ?? 'main');
    const value = await context.evaluateExpression(expression, options, arg);
    return value;
  }

  async evaluateExpressionHandle(expression: string, options: { isFunction?: boolean, world?: types.World } = {}, arg?: any): Promise<js.JSHandle<any>> {

          const context = await this._context(options.world ?? "utility");
          const value = await context.evaluateExpressionHandle(expression, options, arg);
          return value;
        
  }

  async querySelector(selector: string, options: types.StrictOptions): Promise<dom.ElementHandle<Element> | null> {

          return this.querySelectorAll(selector, options).then((handles) => {
            if (handles.length === 0)
              return null;
            if (handles.length > 1 && options?.strict)
              throw new Error(`Strict mode: expected one element matching selector "${selector}", found ${handles.length}`);
            return handles[0];
          });
        
  }

  async waitForSelector(progress: Progress, selector: string, performActionPreChecksAndLog: boolean, options: types.WaitForElementOptions, scope?: dom.ElementHandle): Promise<dom.ElementHandle<Element> | null> {

          if ((options as any).visibility)
            throw new Error('options.visibility is not supported, did you mean options.state?');
          if ((options as any).waitFor && (options as any).waitFor !== 'visible')
            throw new Error('options.waitFor is not supported, did you mean options.state?');
          const { state = 'visible' } = options;
          if (!['attached', 'detached', 'visible', 'hidden'].includes(state))
            throw new Error(`state: expected one of (attached|detached|visible|hidden)`);
          if (performActionPreChecksAndLog)
            progress.log(`waiting for ${this._asLocator(selector)}${state === 'attached' ? '' : ' to be ' + state}`);

          const promise = this._retryWithProgressIfNotConnected(progress, selector, options.strict, true, async handle => {
            const attached = !!handle;
            var visible = false;
            if (attached) {
              if (handle.parentNode.constructor.name == "ElementHandle") {
                visible = await handle.parentNode.evaluateInUtility(([injected, node, { handle }]) => {
                  return handle ? injected.utils.isElementVisible(handle) : false;
                }, { handle });
              } else {
                visible = await handle.parentNode.evaluate((injected, { handle }) => {
                  return handle ? injected.utils.isElementVisible(handle) : false;
                }, { handle });
              }
            }

            const success = {
              attached,
              detached: !attached,
              visible,
              hidden: !visible
            }[state];
            if (!success) return "internal:continuepolling";
            if (options.omitReturnValue) return null;

            const element = state === 'attached' || state === 'visible' ? handle : null;
            if (!element) return null;
            if (options.__testHookBeforeAdoptNode) await options.__testHookBeforeAdoptNode();
            try {
              return element;
            } catch (e) {
              return "internal:continuepolling";
            }
          }, "returnOnNotResolved");

          return scope ? scope._context._raceAgainstContextDestroyed(promise) : promise;
        
  }

  async dispatchEvent(progress: Progress, selector: string, type: string, eventInit: Object = {}, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<void> {
    await this._callOnElementOnceMatches(progress, selector, (injectedScript, element, data) => {
      injectedScript.dispatchEvent(element, data.type, data.eventInit);
    }, { type, eventInit }, { mainWorld: true, ...options }, scope);
  }

  async evalOnSelector(selector: string, strict: boolean, expression: string, isFunction: boolean | undefined, arg: any, scope?: dom.ElementHandle): Promise<any> {
    const handle = await this.selectors.query(selector, { strict }, scope);
            if (!handle)
              throw new Error('Failed to find element matching selector ' + selector);
            const result = await handle.evaluateExpression(expression, { isFunction }, arg, true);
            handle.dispose();
            return result;
  }

  async evalOnSelectorAll(selector: string, expression: string, isFunction: boolean | undefined, arg: any, scope?: dom.ElementHandle, isolatedContext?: boolean): Promise<any> {

          try {
            isolatedContext = this.selectors._parseSelector(selector, { strict: false }).world !== "main" && isolatedContext;
            const arrayHandle = await this.selectors.queryArrayInMainWorld(selector, scope, isolatedContext);
            const result = await arrayHandle.evaluateExpression(expression, { isFunction }, arg, isolatedContext);
            arrayHandle.dispose();
            return result;
          } catch (e) {
            // Do i look like i know whats going on here?
            if ("JSHandles can be evaluated only in the context they were created!" === e.message) return await this.evalOnSelectorAll(selector, expression, isFunction, arg, scope, isolatedContext);
            throw e;
          }
        
  }

  async maskSelectors(selectors: ParsedSelector[], color: string): Promise<void> {
    const context = await this._utilityContext();
    const injectedScript = await context.injectedScript();
    await injectedScript.evaluate((injected, { parsed, color }) => {
      injected.maskSelectors(parsed, color);
    }, { parsed: selectors, color: color });
  }

  async querySelectorAll(selector: string): Promise<dom.ElementHandle<Element>[]> {

          const metadata = { internal: false, log: [], method: "querySelectorAll" };
          const progress = {
            log: message => metadata.log.push(message),
            metadata,
            race: (promise) => Promise.race(Array.isArray(promise) ? promise : [promise])
          }
          return await this._retryWithoutProgress(progress, selector, null, false, async (result) => {
            if (!result || !result[0]) return [];
            return result[1];
          }, 'returnAll', null);
        
  }

  async queryCount(selector: string, options: any): Promise<number> {

          const metadata = { internal: false, log: [], method: "queryCount" };
          const progress = {
            log: message => metadata.log.push(message),
            metadata,
            race: (promise) => Promise.race(Array.isArray(promise) ? promise : [promise])
          }
          return await this._retryWithoutProgress(progress, selector, null, false, async (result) => {
            if (!result) return 0;
            const handle = result[0];
            const handles = result[1];
            return handle ? handles.length : 0;
          }, 'returnAll', null);
        
  }

  async content(): Promise<string> {
    try {
      const context = await this._utilityContext();
      return await context.evaluate(() => {
        let retVal = '';
        if (document.doctype)
          retVal = new XMLSerializer().serializeToString(document.doctype);
        if (document.documentElement)
          retVal += document.documentElement.outerHTML;
        return retVal;
      });
    } catch (e) {
      if (this.isNonRetriableError(e))
        throw e;
      throw new Error(`Unable to retrieve content because the page is navigating and changing the content.`);
    }
  }

  async setContent(progress: Progress, html: string, options: types.NavigateOptions): Promise<void> {

          await this.raceNavigationAction(progress, async () => {
            const waitUntil = options.waitUntil === void 0 ? "load" : options.waitUntil;
            progress.log(`setting frame content, waiting until "${waitUntil}"`);
            const lifecyclePromise = new Promise((resolve, reject) => {
              this._onClearLifecycle();
              this._waitForLoadState(progress, waitUntil).then(resolve).catch(reject);
            });
            const setContentPromise = this._page.delegate._mainFrameSession._client.send("Page.setDocumentContent", {
              frameId: this._id,
              html
            });
            await Promise.all([setContentPromise, lifecyclePromise]);

            return null;
          });
        
  }

  name(): string {
    return this._name || '';
  }

  url(): string {
    return this._url;
  }

  origin(): string | undefined {
    if (!this._url.startsWith('http'))
      return;
    return network.parseURL(this._url)?.origin;
  }

  parentFrame(): Frame | null {
    return this._parentFrame;
  }

  childFrames(): Frame[] {
    return Array.from(this._childFrames);
  }

  async addScriptTag(params: {
      url?: string,
      content?: string,
      type?: string,
    }): Promise<dom.ElementHandle> {
    const {
      url = null,
      content = null,
      type = ''
    } = params;
    if (!url && !content)
      throw new Error('Provide an object with a `url`, `path` or `content` property');

    const context = await this._mainContext();
    return this._raceWithCSPError(async () => {
      if (url !== null)
        return (await context.evaluateHandle(addScriptUrl, { url, type })).asElement()!;
      const result = (await context.evaluateHandle(addScriptContent, { content: content!, type })).asElement()!;
      // Another round trip to the browser to ensure that we receive CSP error messages
      // (if any) logged asynchronously in a separate task on the content main thread.
      if (this._page.delegate.cspErrorsAsynchronousForInlineScripts)
        await context.evaluate(() => true);
      return result;
    });

    async function addScriptUrl(params: { url: string, type: string }): Promise<HTMLElement> {
      const script = document.createElement('script');
      script.src = params.url;
      if (params.type)
        script.type = params.type;
      const promise = new Promise((res, rej) => {
        script.onload = res;
        script.onerror = e => rej(typeof e === 'string' ? new Error(e) : new Error(`Failed to load script at ${script.src}`));
      });
      document.head.appendChild(script);
      await promise;
      return script;
    }

    function addScriptContent(params: { content: string, type: string }): HTMLElement {
      const script = document.createElement('script');
      script.type = params.type || 'text/javascript';
      script.text = params.content;
      let error = null;
      script.onerror = e => error = e;
      document.head.appendChild(script);
      if (error)
        throw error;
      return script;
    }
  }

  async addStyleTag(params: { url?: string, content?: string }): Promise<dom.ElementHandle> {
    const {
      url = null,
      content = null
    } = params;
    if (!url && !content)
      throw new Error('Provide an object with a `url`, `path` or `content` property');

    const context = await this._mainContext();
    return this._raceWithCSPError(async () => {
      if (url !== null)
        return (await context.evaluateHandle(addStyleUrl, url)).asElement()!;
      return (await context.evaluateHandle(addStyleContent, content!)).asElement()!;
    });

    async function addStyleUrl(url: string): Promise<HTMLElement> {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      const promise = new Promise((res, rej) => {
        link.onload = res;
        link.onerror = rej;
      });
      document.head.appendChild(link);
      await promise;
      return link;
    }

    async function addStyleContent(content: string): Promise<HTMLElement> {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.appendChild(document.createTextNode(content));
      const promise = new Promise((res, rej) => {
        style.onload = res;
        style.onerror = rej;
      });
      document.head.appendChild(style);
      await promise;
      return style;
    }
  }

  private async _raceWithCSPError(func: () => Promise<dom.ElementHandle>): Promise<dom.ElementHandle> {
    const listeners: RegisteredListener[] = [];
    let result: dom.ElementHandle;
    let error: Error | undefined;
    let cspMessage: ConsoleMessage | undefined;
    const actionPromise = func().then(r => result = r).catch(e => error = e);
    const errorPromise = new Promise<void>(resolve => {
      listeners.push(eventsHelper.addEventListener(this._page.browserContext, BrowserContext.Events.Console, (message: ConsoleMessage) => {
        if (message.page() !== this._page || message.type() !== 'error')
          return;
        if (message.text().includes('Content-Security-Policy') || message.text().includes('Content Security Policy')) {
          cspMessage = message;
          resolve();
        }
      }));
    });
    await Promise.race([actionPromise, errorPromise]);
    eventsHelper.removeEventListeners(listeners);
    if (cspMessage)
      throw new Error(cspMessage.text());
    if (error)
      throw error;
    return result!;
  }

  async retryWithProgressAndTimeouts<R>(progress: Progress, timeouts: number[], action: (continuePolling: symbol) => Promise<R | symbol>): Promise<R> {
    const continuePolling = Symbol('continuePolling');
    timeouts = [0, ...timeouts];
    let timeoutIndex = 0;
    while (true) {
      const timeout = timeouts[Math.min(timeoutIndex++, timeouts.length - 1)];
      if (timeout) {
        // Make sure we react immediately upon page close or frame detach.
        // We need this to show expected/received values in time.
        const actionPromise = new Promise(f => setTimeout(f, timeout));
        await progress.race(LongStandingScope.raceMultiple([
          this._page.openScope,
          this._detachedScope,
        ], actionPromise));
      }
      try {
        const result = await action(continuePolling);
        if (result === continuePolling)
          continue;
        return result as R;
      } catch (e) {
        if (this.isNonRetriableError(e))
          throw e;
        continue;
      }
    }
  }

  isNonRetriableError(e: Error) {
    if (isAbortError(e))
      return true;
    // Always fail on JavaScript errors or when the main connection is closed.
    if (js.isJavaScriptErrorInEvaluate(e) || isSessionClosedError(e))
      return true;
    // Certain errors opt-out of the retries, throw.
    if (dom.isNonRecoverableDOMError(e) || isInvalidSelectorError(e))
      return true;
    // If the call is made on the detached frame - throw.
    if (this.isDetached())
      return true;
    // Retry upon all other errors.
    return false;
  }

  private async _retryWithProgressIfNotConnected<R>(
    progress: Progress,
    selector: string,
    strict: boolean | undefined,
    performActionPreChecks: boolean,
    action: (handle: dom.ElementHandle<Element>) => Promise<R | 'error:notconnected'>, returnAction: boolean | undefined): Promise<R> {

          progress.log("waiting for " + this._asLocator(selector));
          return this.retryWithProgressAndTimeouts(progress, [0, 20, 50, 100, 100, 500], async continuePolling => {
            return this._retryWithoutProgress(progress, selector, strict, performActionPreChecks, action, returnAction, continuePolling);
          });
        
  }

  async rafrafTimeoutScreenshotElementWithProgress(progress: Progress, selector: string, timeout: number, options: ScreenshotOptions): Promise<Buffer> {
    return await this._retryWithProgressIfNotConnected(progress, selector, true /* strict */, true /* performActionPreChecks */, async handle => {
      await handle._frame.rafrafTimeout(progress, timeout);
      return await this._page.screenshotter.screenshotElement(progress, handle, options);
    });
  }

  async click(progress: Progress, selector: string, options: { noWaitAfter?: boolean } & types.MouseClickOptions & types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._click(progress, { ...options, waitAfter: !options.noWaitAfter })));
  }

  async dblclick(progress: Progress, selector: string, options: types.MouseMultiClickOptions & types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._dblclick(progress, options)));
  }

  async dragAndDrop(progress: Progress, source: string, target: string, options: types.DragActionOptions & types.PointerActionWaitOptions) {
    dom.assertDone(await this._retryWithProgressIfNotConnected(progress, source, options.strict, !options.force /* performActionPreChecks */, async handle => {
      return handle._retryPointerAction(progress, 'move and down', false, async point => {
        await this._page.mouse.move(progress, point.x, point.y);
        await this._page.mouse.down(progress);
      }, {
        ...options,
        waitAfter: 'disabled',
        position: options.sourcePosition,
      });
    }));
    // Note: do not perform locator handlers checkpoint to avoid moving the mouse in the middle of a drag operation.
    dom.assertDone(await this._retryWithProgressIfNotConnected(progress, target, options.strict, false /* performActionPreChecks */, async handle => {
      return handle._retryPointerAction(progress, 'move and up', false, async point => {
        await this._page.mouse.move(progress, point.x, point.y);
        await this._page.mouse.up(progress);
      }, {
        ...options,
        waitAfter: 'disabled',
        position: options.targetPosition,
      });
    }));
  }

  async tap(progress: Progress, selector: string, options: types.PointerActionWaitOptions) {
    if (!this._page.browserContext._options.hasTouch)
      throw new Error('The page does not support tap. Use hasTouch context option to enable touch support.');
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._tap(progress, options)));
  }

  async fill(progress: Progress, selector: string, value: string, options: types.StrictOptions & { force?: boolean }) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._fill(progress, value, options)));
  }

  async focus(progress: Progress, selector: string, options: types.StrictOptions) {
    dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, true /* performActionPreChecks */, handle => handle._focus(progress)));
  }

  async blur(progress: Progress, selector: string, options: types.StrictOptions) {
    dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, true /* performActionPreChecks */, handle => handle._blur(progress)));
  }

  async resolveSelector(progress: Progress, selector: string, options: { mainWorld?: boolean } = {}): Promise<{ resolvedSelector: string }> {
    const element = await progress.race(this.selectors.query(selector, options));
    if (!element)
      throw new Error(`No element matching ${selector}`);

    const generated = await progress.race(element.evaluateInUtility(async ([injected, node]) => {
      return injected.generateSelectorSimple(node as unknown as Element);
    }, {}));
    if (!generated)
      throw new Error(`Unable to generate locator for ${selector}`);

    let frame: Frame | null = element._frame;
    const result = [generated];
    while (frame?.parentFrame()) {
      const frameElement = await progress.race(frame.frameElement());
      if (frameElement) {
        const generated = await progress.race(frameElement.evaluateInUtility(async ([injected, node]) => {
          return injected.generateSelectorSimple(node as unknown as Element);
        }, {}));
        frameElement.dispose();
        if (generated === 'error:notconnected' || !generated)
          throw new Error(`Unable to generate locator for ${selector}`);
        result.push(generated);
      }
      frame = frame.parentFrame();
    }
    const resolvedSelector = result.reverse().join(' >> internal:control=enter-frame >> ');
    return { resolvedSelector };
  }

  async textContent(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<string | null> {
    return this._callOnElementOnceMatches(progress, selector, (injected, element) => element.textContent, undefined, options, scope);
  }

  async innerText(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<string> {
    return this._callOnElementOnceMatches(progress, selector, (injectedScript, element) => {
      if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml')
        throw injectedScript.createStacklessError('Node is not an HTMLElement');
      return (element as HTMLElement).innerText;
    }, undefined, options, scope);
  }

  async innerHTML(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<string> {
    return this._callOnElementOnceMatches(progress, selector, (injected, element) => element.innerHTML, undefined, options, scope);
  }

  async getAttribute(progress: Progress, selector: string, name: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<string | null> {
    return this._callOnElementOnceMatches(progress, selector, (injected, element, data) => element.getAttribute(data.name), { name }, options, scope);
  }

  async inputValue(progress: Progress, selector: string, options: types.StrictOptions, scope?: dom.ElementHandle): Promise<string> {
    return this._callOnElementOnceMatches(progress, selector, (injectedScript, node) => {
      const element = injectedScript.retarget(node, 'follow-label');
      if (!element || (element.nodeName !== 'INPUT' && element.nodeName !== 'TEXTAREA' && element.nodeName !== 'SELECT'))
        throw injectedScript.createStacklessError('Node is not an <input>, <textarea> or <select> element');
      return (element as any).value;
    }, undefined, options, scope);
  }

  async highlight(progress: Progress, selector: string) {
    const resolved = await progress.race(this.selectors.resolveInjectedForSelector(selector));
    if (!resolved)
      return;
    return await progress.race(resolved.injected.evaluate((injected, { info }) => {
      return injected.highlight(info.parsed);
    }, { info: resolved.info }));
  }

  async hideHighlight() {
    return this.raceAgainstEvaluationStallingEvents(async () => {
      const context = await this._utilityContext();
      const injectedScript = await context.injectedScript();
      return await injectedScript.evaluate(injected => {
        return injected.hideHighlight();
      });
    });
  }

  private async _elementState(progress: Progress, selector: string, state: ElementStateWithoutStable, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<boolean> {
    const result = await this._callOnElementOnceMatches(progress, selector, (injected, element, data) => {
      return injected.elementState(element, data.state);
    }, { state }, options, scope);
    if (result.received === 'error:notconnected')
      dom.throwElementIsNotAttached();
    return result.matches;
  }

  async isVisible(progress: Progress, selector: string, options: types.StrictOptions = {}, scope?: dom.ElementHandle): Promise<boolean> {
    progress.log(`  checking visibility of ${this._asLocator(selector)}`);
    return await this.isVisibleInternal(progress, selector, options, scope);
  }

  async isVisibleInternal(progress: Progress, selector: string, options: types.StrictOptions = {}, scope?: dom.ElementHandle): Promise<boolean> {

          try {
            const metadata = { internal: false, log: [], method: "isVisible" };
            const progress = {
              log: message => metadata.log.push(message),
              metadata,
              race: (promise) => Promise.race(Array.isArray(promise) ? promise : [promise])
            }
            progress.log("waiting for " + this._asLocator(selector));
            if (selector === ":scope") {
              const scopeParentNode = scope.parentNode || scope;
              if (scopeParentNode.constructor.name == "ElementHandle") {
                return await scopeParentNode.evaluateInUtility(([injected, node, { scope: handle2 }]) => {
                  const state = handle2 ? injected.elementState(handle2, "visible") : {
                    matches: false,
                    received: "error:notconnected"
                  };
                  return state.matches;
                }, { scope });
              } else {
                return await scopeParentNode.evaluate((injected, node, { scope: handle2 }) => {
                  const state = handle2 ? injected.elementState(handle2, "visible") : {
                    matches: false,
                    received: "error:notconnected"
                  };
                  return state.matches;
                }, { scope });
              }
            } else {
              return await this._retryWithoutProgress(progress, selector, options.strict, false, async (handle) => {
                if (!handle) return false;
                if (handle.parentNode.constructor.name == "ElementHandle") {
                  return await handle.parentNode.evaluateInUtility(([injected, node, { handle: handle2 }]) => {
                    const state = handle2 ? injected.elementState(handle2, "visible") : {
                      matches: false,
                      received: "error:notconnected"
                    };
                    return state.matches;
                  }, { handle });
                } else {
                  return await handle.parentNode.evaluate((injected, { handle: handle2 }) => {
                    const state = handle2 ? injected.elementState(handle2, "visible") : {
                      matches: false,
                      received: "error:notconnected"
                    };
                    return state.matches;
                  }, { handle });
                }
              }, "returnOnNotResolved", null);
            }
          } catch (e) {
            if (this.isNonRetriableError(e)) throw e;
            return false;
          }
        
  }

  async isHidden(progress: Progress, selector: string, options: types.StrictOptions = {}, scope?: dom.ElementHandle): Promise<boolean> {
    return !(await this.isVisible(progress, selector, options, scope));
  }

  async isDisabled(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<boolean> {
    return this._elementState(progress, selector, 'disabled', options, scope);
  }

  async isEnabled(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<boolean> {
    return this._elementState(progress, selector, 'enabled', options, scope);
  }

  async isEditable(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<boolean> {
    return this._elementState(progress, selector, 'editable', options, scope);
  }

  async isChecked(progress: Progress, selector: string, options: types.QueryOnSelectorOptions, scope?: dom.ElementHandle): Promise<boolean> {
    return this._elementState(progress, selector, 'checked', options, scope);
  }

  async hover(progress: Progress, selector: string, options: types.PointerActionOptions & types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._hover(progress, options)));
  }

  async selectOption(progress: Progress, selector: string, elements: dom.ElementHandle[], values: types.SelectOption[], options: types.CommonActionOptions): Promise<string[]> {
    return await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._selectOption(progress, elements, values, options));
  }

  async setInputFiles(progress: Progress, selector: string, params: Omit<channels.FrameSetInputFilesParams, 'timeout'>): Promise<channels.FrameSetInputFilesResult> {
    const inputFileItems = await prepareFilesForUpload(this, params);
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, params.strict, true /* performActionPreChecks */, handle => handle._setInputFiles(progress, inputFileItems)));
  }

  async type(progress: Progress, selector: string, text: string, options: { delay?: number } & types.StrictOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, true /* performActionPreChecks */, handle => handle._type(progress, text, options)));
  }

  async press(progress: Progress, selector: string, key: string, options: { delay?: number, noWaitAfter?: boolean } & types.StrictOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, true /* performActionPreChecks */, handle => handle._press(progress, key, options)));
  }

  async check(progress: Progress, selector: string, options: types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._setChecked(progress, true, options)));
  }

  async uncheck(progress: Progress, selector: string, options: types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force /* performActionPreChecks */, handle => handle._setChecked(progress, false, options)));
  }

  async waitForTimeout(progress: Progress, timeout: number) {
    return progress.wait(timeout);
  }

  async ariaSnapshot(progress: Progress, selector: string): Promise<string> {
    return await this._retryWithProgressIfNotConnected(progress, selector, true /* strict */, true /* performActionPreChecks */, handle => progress.race(handle.ariaSnapshot()));
  }

  async expect(progress: Progress, selector: string | undefined, options: FrameExpectParams, timeout?: number): Promise<ExpectResult> {
    progress.log(`${renderTitleForCall(progress.metadata)}${timeout ? ` with timeout ${timeout}ms` : ''}`);
    const lastIntermediateResult: { received?: any, isSet: boolean } = { isSet: false };
    const fixupMetadataError = (result: ExpectResult) => {
      // Library mode special case for the expect errors which are return values, not exceptions.
      if (result.matches === options.isNot)
        progress.metadata.error = { error: { name: 'Expect', message: 'Expect failed' } };
    };
    try {
      // Step 1: perform locator handlers checkpoint with a specified timeout.
      if (selector)
        progress.log(`waiting for ${this._asLocator(selector)}`);
      await this._page.performActionPreChecks(progress);

      // Step 2: perform one-shot expect check without a timeout.
      // Supports the case of `expect(locator).toBeVisible({ timeout: 1 })`
      // that should succeed when the locator is already visible.
      try {
        const resultOneShot = await this._expectInternal(progress, selector, options, lastIntermediateResult, true);
        if (resultOneShot.matches !== options.isNot)
          return resultOneShot;
      } catch (e) {
        if (this.isNonRetriableError(e))
          throw e;
        // Ignore any other errors from one-shot, we'll handle them during retries.
      }

      // Step 3: auto-retry expect with increasing timeouts. Bounded by the total remaining time.
      const result = await this.retryWithProgressAndTimeouts(progress, [100, 250, 500, 1000], async continuePolling => {
        await this._page.performActionPreChecks(progress);
        const { matches, received } = await this._expectInternal(progress, selector, options, lastIntermediateResult, false);
        if (matches === options.isNot) {
          // Keep waiting in these cases:
          // expect(locator).conditionThatDoesNotMatch
          // expect(locator).not.conditionThatDoesMatch
          return continuePolling;
        }
        return { matches, received };
      });
      fixupMetadataError(result);
      return result;
    } catch (e) {
      // Q: Why not throw upon isNonRetriableError(e) as in other places?
      // A: We want user to receive a friendly message containing the last intermediate result.
      if (js.isJavaScriptErrorInEvaluate(e) || isInvalidSelectorError(e))
        throw e;
      const result: ExpectResult = { matches: options.isNot, log: compressCallLog(progress.metadata.log) };
      if (lastIntermediateResult.isSet)
        result.received = lastIntermediateResult.received;
      if (e instanceof TimeoutError)
        result.timedOut = true;
      fixupMetadataError(result);
      return result;
    }
  }

  private async _expectInternal(progress: Progress, selector: string | undefined, options: FrameExpectParams, lastIntermediateResult: { received?: any, isSet: boolean }, noAbort: boolean) {

          // The first expect check, a.k.a. one-shot, always finishes - even when progress is aborted.
          const race = (p) => noAbort ? p : progress.race(p);
          const isArray = options.expression === 'to.have.count' || options.expression.endsWith('.array');
          var log, matches, received, missingReceived;
          if (selector) {
            const { frame, info } = await race(this.selectors.resolveFrameForSelector(selector, { strict: true }));
            const action = async result => {
              if (!result) {
                if (options.expectedNumber === 0)
                  return { matches: true };
                // expect(locator).toBeHidden() passes when there is no element.
                if (!options.isNot && options.expression === 'to.be.hidden')
                  return { matches: true };
                // expect(locator).not.toBeVisible() passes when there is no element.
                if (options.isNot && options.expression === 'to.be.visible')
                  return { matches: false };
                // expect(locator).toBeAttached({ attached: false }) passes when there is no element.
                if (!options.isNot && options.expression === 'to.be.detached')
                  return { matches: true };
                // expect(locator).not.toBeAttached() passes when there is no element.
                if (options.isNot && options.expression === 'to.be.attached')
                  return { matches: false };
                // expect(locator).not.toBeInViewport() passes when there is no element.
                if (options.isNot && options.expression === 'to.be.in.viewport')
                  return { matches: false };
                // When none of the above applies, expect does not match.
                return { matches: options.isNot, missingReceived: true };
              }

              const handle = result[0];
              const handles = result[1];

              if (handle.parentNode.constructor.name == "ElementHandle") {
                return await handle.parentNode.evaluateInUtility(async ([injected, node, { handle, options, handles }]) => {
                  return await injected.expect(handle, options, handles);
                }, { handle, options, handles });
              } else {
                return await handle.parentNode.evaluate(async (injected, { handle, options, handles }) => {
                  return await injected.expect(handle, options, handles);
                }, { handle, options, handles });
              }
            }

            if (noAbort) {
              var { log, matches, received, missingReceived } = await this._retryWithoutProgress(progress, selector, !isArray, false, action, 'returnAll', null);
            } else {
              var { log, matches, received, missingReceived } = await race(this._retryWithProgressIfNotConnected(progress, selector, !isArray, false, action, 'returnAll'));
            }
          } else {
            const world = options.expression === 'to.have.property' ? 'main' : 'utility';
            const context = await race(this._context(world));
            const injected = await race(context.injectedScript());
            var { matches, received, missingReceived } = await race(injected.evaluate(async (injected, { options, callId }) => {
              return { ...await injected.expect(undefined, options, []) };
            }, { options, callId: progress.metadata.id }));
          }


          if (log)
            progress.log(log);
          // Note: missingReceived avoids `unexpected value "undefined"` when element was not found.
          if (matches === options.isNot) {
            lastIntermediateResult.received = missingReceived ? '<element(s) not found>' : received;
            lastIntermediateResult.isSet = true;
            if (!missingReceived && !Array.isArray(received))
              progress.log(`  unexpected value "${renderUnexpectedValue(options.expression, received)}"`);
          }
          return { matches, received };
        
  }

  async waitForFunctionExpression<R>(progress: Progress, expression: string, isFunction: boolean | undefined, arg: any, options: { pollingInterval?: number }, world: types.World = 'main'): Promise<js.SmartHandle<R>> {
    if (typeof options.pollingInterval === 'number')
      assert(options.pollingInterval > 0, 'Cannot poll with non-positive interval: ' + options.pollingInterval);
    expression = js.normalizeEvaluationExpression(expression, isFunction);
    return this.retryWithProgressAndTimeouts(progress, [100], async () => {
      const context = world === 'main' ? await progress.race(this._mainContext()) : await progress.race(this._utilityContext());
      const injectedScript = await progress.race(context.injectedScript());
      const handle = await progress.race(injectedScript.evaluateHandle((injected, { expression, isFunction, polling, arg }) => {
        let evaledExpression: any;
        const predicate = (): R => {
          // NOTE: make sure to use `globalThis.eval` instead of `self.eval` due to a bug with sandbox isolation
          // in firefox.
          // See https://bugzilla.mozilla.org/show_bug.cgi?id=1814898
          let result = evaledExpression ?? globalThis.eval(expression);
          if (isFunction === true) {
            evaledExpression = result;
            result = result(arg);
          } else if (isFunction === false) {
            result = result;
          } else {
            // auto detect.
            if (typeof result === 'function') {
              evaledExpression = result;
              result = result(arg);
            }
          }
          return result;
        };

        let fulfill: (result: R) => void;
        let reject: (error: Error) => void;
        let aborted = false;
        const result = new Promise<R>((f, r) => { fulfill = f; reject = r; });

        const next = () => {
          if (aborted)
            return;
          try {
            const success = predicate();
            if (success) {
              fulfill(success);
              return;
            }
            if (typeof polling !== 'number')
              injected.utils.builtins.requestAnimationFrame(next);
            else
              injected.utils.builtins.setTimeout(next, polling);
          } catch (e) {
            reject(e);
          }
        };

        next();
        return { result, abort: () => aborted = true };
      }, { expression, isFunction, polling: options.pollingInterval, arg }));
      try {
        return await progress.race(handle.evaluateHandle(h => h.result));
      } catch (error) {
        // Note: it is important to await "abort()" to prevent any side effects
        // after this method returns.
        await handle.evaluate(h => h.abort()).catch(() => {});
        throw error;
      } finally {
        handle.dispose();
      }
    });
  }

  async waitForFunctionValueInUtility<R>(progress: Progress, pageFunction: js.Func1<any, R>) {
    const expression = `() => {
      const result = (${pageFunction})();
      if (!result)
        return result;
      return JSON.stringify(result);
    }`;
    const handle = await this.waitForFunctionExpression(progress, expression, true, undefined, {}, 'utility');
    return JSON.parse(handle.rawValue()) as R;
  }

  async title(): Promise<string> {
    const context = await this._utilityContext();
    return context.evaluate(() => document.title);
  }

  async rafrafTimeout(progress: Progress, timeout: number): Promise<void> {
    if (timeout === 0)
      return;
    const context = await progress.race(this._utilityContext());
    await Promise.all([
      // wait for double raf
      progress.race(context.evaluate(() => new Promise(x => {
        requestAnimationFrame(() => {
          requestAnimationFrame(x);
        });
      }))),
      progress.wait(timeout),
    ]);
  }

  _onDetached() {
    this._stopNetworkIdleTimer();
    this._detachedScope.close(new Error('Frame was detached'));
    for (const data of this._contextData.values()) {
      if (data.context)
        data.context.contextDestroyed('Frame was detached');
      data.contextPromise.resolve({ destroyedReason: 'Frame was detached' });
    }
    if (this._parentFrame)
      this._parentFrame._childFrames.delete(this);
    this._parentFrame = null;
  }

  private async _callOnElementOnceMatches<T, R>(progress: Progress, selector: string, body: ElementCallback<T, R>, taskData: T, options: types.StrictOptions & { mainWorld?: boolean }, scope?: dom.ElementHandle): Promise<R> {

          const callbackText = body.toString();
          progress.log("waiting for "+ this._asLocator(selector));
          var promise;
          if (selector === ":scope") {
            const scopeParentNode = scope.parentNode || scope;
            if (scopeParentNode.constructor.name == "ElementHandle") {
              promise = scopeParentNode.evaluateInUtility(([injected, node, { callbackText: callbackText2, scope: handle2, taskData: taskData2 }]) => {
                const callback = injected.eval(callbackText2);
                const haha = callback(injected, handle2, taskData2);
                return haha;
              }, {
                callbackText,
                scope,
                taskData
              });
            } else {
              promise = scopeParentNode.evaluate((injected, { callbackText: callbackText2, scope: handle2, taskData: taskData2 }) => {
                const callback = injected.eval(callbackText2);
                return callback(injected, handle2, taskData2);
              }, {
                callbackText,
                scope,
                taskData
              });
            }
          } else {
            promise = this._retryWithProgressIfNotConnected(progress, selector, options.strict, false, async (handle) => {
              if (handle.parentNode.constructor.name == "ElementHandle") {
                return await handle.parentNode.evaluateInUtility(([injected, node, { callbackText: callbackText2, handle: handle2, taskData: taskData2 }]) => {
                  const callback = injected.eval(callbackText2);
                  const haha = callback(injected, handle2, taskData2);
                  return haha;
                }, {
                  callbackText,
                  handle,
                  taskData
                });
              } else {
                return await handle.parentNode.evaluate((injected, { callbackText: callbackText2, handle: handle2, taskData: taskData2 }) => {
                  const callback = injected.eval(callbackText2);
                  return callback(injected, handle2, taskData2);
                }, {
                  callbackText,
                  handle,
                  taskData
                });
              }
            })
          }
          return scope ? scope._context._raceAgainstContextDestroyed(promise) : promise;
        
  }

  private _setContext(world: types.World, context: dom.FrameExecutionContext | null) {
    const data = this._contextData.get(world)!;
    data.context = context;
    if (context)
      data.contextPromise.resolve(context);
    else
      data.contextPromise = new ManualPromise();
  }

  _contextCreated(world: types.World, context: dom.FrameExecutionContext) {
    const data = this._contextData.get(world)!;
    // In case of multiple sessions to the same target, there's a race between
    // connections so we might end up creating multiple isolated worlds.
    // We can use either.
    if (data.context) {
      data.context.contextDestroyed('Execution context was destroyed, most likely because of a navigation');
      this._setContext(world, null);
    }
    this._setContext(world, context);
  }

  _contextDestroyed(context: dom.FrameExecutionContext) {
    // Sometimes we get this after detach, in which case we should not reset
    // our already destroyed contexts to something that will never resolve.
    if (this._detachedScope.isClosed())
      return;
    context.contextDestroyed('Execution context was destroyed, most likely because of a navigation');
    for (const [world, data] of this._contextData) {
      if (data.context === context)
        this._setContext(world, null);
    }
  }

  _startNetworkIdleTimer() {
    assert(!this._networkIdleTimer);
    // We should not start a timer and report networkidle in detached frames.
    // This happens at least in Firefox for child frames, where we may get requestFinished
    // after the frame was detached - probably a race in the Firefox itself.
    if (this._firedLifecycleEvents.has('networkidle') || this._detachedScope.isClosed())
      return;
    this._networkIdleTimer = setTimeout(() => {
      this._firedNetworkIdleSelf = true;
      this._page.mainFrame()._recalculateNetworkIdle();
    }, 500);
  }

  _stopNetworkIdleTimer() {
    if (this._networkIdleTimer)
      clearTimeout(this._networkIdleTimer);
    this._networkIdleTimer = undefined;
    this._firedNetworkIdleSelf = false;
  }

  async extendInjectedScript(source: string, arg?: any) {
    const context = await this._context('main');
    const injectedScriptHandle = await context.injectedScript();
    await injectedScriptHandle.evaluate((injectedScript, { source, arg }) => {
      injectedScript.extend(source, arg);
    }, { source, arg });
  }

  private _asLocator(selector: string) {
    return asLocator(this._page.browserContext._browser.sdkLanguage(), selector);
  }

  _isolatedWorld: dom.FrameExecutionContext;
  _mainWorld: dom.FrameExecutionContext;
  _iframeWorld: dom.FrameExecutionContext;

  async _getFrameMainFrameContextId(client): Promise<number> {

          try {
            var globalDocument = await client._sendMayFail("DOM.getFrameOwner", {frameId: this._id,});
            if (globalDocument && globalDocument.nodeId) {
              var describedNode = await client._sendMayFail("DOM.describeNode", {
                backendNodeId: globalDocument.backendNodeId,
              });
              if (describedNode) {
                var resolvedNode = await client._sendMayFail("DOM.resolveNode", {
                  nodeId: describedNode.node.contentDocument.nodeId,
                });
                var _executionContextId = parseInt(resolvedNode.object.objectId.split(".")[1], 10);
                return _executionContextId;
              }
            }
          } catch (e) {}
          return 0;
        
  }

  async _retryWithoutProgress(progress, selector, strict, performActionPreChecks, action, returnAction, continuePolling) {

          if (performActionPreChecks) await this._page.performActionPreChecks(progress);
          const resolved = await this.selectors.resolveInjectedForSelector(selector, { strict });
          if (!resolved) {
            if (returnAction === 'returnOnNotResolved' || returnAction === 'returnAll') {
              const result = await action(null);
              return result === "internal:continuepolling" ? continuePolling : result;
            }
            return continuePolling;
          }

          try {
            var client = this._page.delegate._sessionForFrame(resolved.frame)._client;
          } catch (e) {
            var client = this._page.delegate._mainFrameSession._client;
          }
          var utilityContext = await resolved.frame._utilityContext();
          var mainContext = await resolved.frame._mainContext();
          const documentNode = await client._sendMayFail('Runtime.evaluate', {
            expression: "document",
            serializationOptions: {
              serialization: "idOnly"
            },
            contextId: utilityContext.delegate._contextId,
          });
          if (!documentNode) return continuePolling;
          const documentScope = new dom.ElementHandle(utilityContext, documentNode.result.objectId);

          let currentScopingElements;
          try {
            currentScopingElements = await this._customFindElementsByParsed(resolved, client, mainContext, documentScope, progress, resolved.info.parsed);
          } catch (e) {
            if ("JSHandles can be evaluated only in the context they were created!" === e.message) return continuePolling3;
            await progress.race(resolved.injected.evaluateHandle((injected, { error }) => { throw error }, { error: e }));
          }

          if (currentScopingElements.length == 0) {
            // TODO: Dispose?
            if (returnAction === 'returnOnNotResolved' || returnAction === 'returnAll') {
            const result = await action(null);
            return result === "internal:continuepolling" ? continuePolling2 : result;
          }
            return continuePolling;
          }
          const resultElement = currentScopingElements[0];
          if (currentScopingElements.length > 1) {
            if (resolved.info.strict) {
              await progress.race(resolved.injected.evaluateHandle((injected, {
                info,
                elements
              }) => {
                throw injected.strictModeViolationError(info.parsed, elements);
              }, {
                info: resolved.info,
                elements: currentScopingElements
              }));
            }
            progress.log("  locator resolved to " + currentScopingElements.length + " elements. Proceeding with the first one: " + resultElement.preview());
          } else if (resultElement) {
            progress.log("  locator resolved to " + resultElement.preview());
          }

          try {
            var result = null;
            if (returnAction === 'returnAll') {
              result = await action([resultElement, currentScopingElements]);
            } else {
              result = await action(resultElement);
            }
            if (result === 'error:notconnected') {
              progress.log('element was detached from the DOM, retrying');
              return continuePolling;
            } else if (result === 'internal:continuepolling') {
              return continuePolling;
            }
            return result;
          } finally {}
        
  }

  async _customFindElementsByParsed(resolved, client, context, documentScope, progress, parsed) {

          var parsedEdits = { ...parsed };
          // Note: We start scoping at document level
          var currentScopingElements = [documentScope];
          while (parsed.parts.length > 0) {
            var part = parsed.parts.shift();
            parsedEdits.parts = [part];
            // Getting All Elements
            var elements = [];
            var elementsIndexes = [];

            if (part.name == "nth") {
              const partNth = Number(part.body);
              // Check if any Elements are currently scoped, else return empty array to continue polling
              if (currentScopingElements.length == 0) return [];
              // Check if the partNth is within the bounds of currentScopingElements
              if (partNth > currentScopingElements.length-1 || partNth < -(currentScopingElements.length-1)) {
                if (parsed.capture !== undefined) throw new Error("Can't query n-th element in a request with the capture.");
                return [];
              } else {
                currentScopingElements = [currentScopingElements.at(partNth)];
                continue;
              }
            } else if (part.name == "internal:or") {
              var orredElements = await this._customFindElementsByParsed(resolved, client, context, documentScope, progress, part.body.parsed);
              elements = currentScopingElements.concat(orredElements);
            } else if (part.name == "internal:and") {
              var andedElements = await this._customFindElementsByParsed(resolved, client, context, documentScope, progress, part.body.parsed);
              const backendNodeIds = new Set(andedElements.map(item => item.backendNodeId));
              elements = currentScopingElements.filter(item => backendNodeIds.has(item.backendNodeId));
            } else {
              for (const scope of currentScopingElements) {
                const describedScope = await client.send('DOM.describeNode', {
                  objectId: scope._objectId,
                  depth: -1,
                  pierce: true
                });

                // Elements Queryed in the "current round"
                var queryingElements = [];
                function findClosedShadowRoots(node, results = []) {
                  if (!node || typeof node !== 'object') return results;
                  if (node.shadowRoots && Array.isArray(node.shadowRoots)) {
                    for (const shadowRoot of node.shadowRoots) {
                      if (shadowRoot.shadowRootType === 'closed' && shadowRoot.backendNodeId) {
                        results.push(shadowRoot.backendNodeId);
                      }
                      findClosedShadowRoots(shadowRoot, results);
                    }
                  }
                  if (node.nodeName !== 'IFRAME' && node.children && Array.isArray(node.children)) {
                    for (const child of node.children) {
                      findClosedShadowRoots(child, results);
                    }
                  }
                  return results;
                }

                var shadowRootBackendIds = findClosedShadowRoots(describedScope.node);
                var shadowRoots = [];
                for (var shadowRootBackendId of shadowRootBackendIds) {
                  var resolvedShadowRoot = await client.send('DOM.resolveNode', {
                    backendNodeId: shadowRootBackendId,
                    contextId: context.delegate._contextId
                  });
                  shadowRoots.push(new dom.ElementHandle(context, resolvedShadowRoot.object.objectId));
                }

                for (var shadowRoot of shadowRoots) {
                  const shadowElements = await shadowRoot.evaluateHandleInUtility(([injected, node, { parsed, callId }]) => {
                   const elements = injected.querySelectorAll(parsed, node);
                    if (callId) injected.markTargetElements(new Set(elements), callId);
                    return elements
                  }, {
                    parsed: parsedEdits,
                    callId: progress.metadata.id
                  });

                  const shadowElementsAmount = await shadowElements.getProperty("length");
                  queryingElements.push([shadowElements, shadowElementsAmount, shadowRoot]);
                }

                // Document Root Elements (not in CSR)
                const rootElements = await scope.evaluateHandleInUtility(([injected, node, { parsed, callId }]) => {
                  const elements = injected.querySelectorAll(parsed, node);
                  if (callId) injected.markTargetElements(new Set(elements), callId);
                  return elements
                }, {
                  parsed: parsedEdits,
                  callId: progress.metadata.id
                });
                const rootElementsAmount = await rootElements.getProperty("length");
                queryingElements.push([rootElements, rootElementsAmount, scope]);

                // Querying and Sorting the elements by their backendNodeId
                for (var queryedElement of queryingElements) {
                  var elementsToCheck = queryedElement[0];
                  var elementsAmount = await queryedElement[1].jsonValue();
                  var parentNode = queryedElement[2];
                  for (var i = 0; i < elementsAmount; i++) {
                    if (parentNode.constructor.name == "ElementHandle") {
                      var elementToCheck = await parentNode.evaluateHandleInUtility(([injected, node, { index, elementsToCheck }]) => { return elementsToCheck[index]; }, { index: i, elementsToCheck: elementsToCheck });
                    } else {
                      var elementToCheck = await parentNode.evaluateHandle((injected, { index, elementsToCheck }) => { return elementsToCheck[index]; }, { index: i, elementsToCheck: elementsToCheck });
                    }
                    // For other Functions/Utilities
                    elementToCheck.parentNode = parentNode;
                    var resolvedElement = await client.send('DOM.describeNode', {
                      objectId: elementToCheck._objectId,
                      depth: -1,
                    });
                    // Note: Possible Bug, Maybe well actually have to check the Documents Node Position instead of using the backendNodeId
                    elementToCheck.backendNodeId = resolvedElement.node.backendNodeId;
                    elements.push(elementToCheck);
                  }
                }
              }
            }
            // Setting currentScopingElements to the elements we just queried
            currentScopingElements = [];
            for (var element of elements) {
              var elemIndex = element.backendNodeId;
              // prevent duplicate elements
              if (elementsIndexes.includes(elemIndex)) continue
              // Sorting the Elements by their occourance in the DOM
              var elemPos = elementsIndexes.findIndex(index => index > elemIndex);

              // Sort the elements by their backendNodeId
              if (elemPos === -1) {
                currentScopingElements.push(element);
                elementsIndexes.push(elemIndex);
              } else {
                currentScopingElements.splice(elemPos, 0, element);
                elementsIndexes.splice(elemPos, 0, elemIndex);
              }
            }
          }
          return currentScopingElements;
        
  }
}

class SignalBarrier {
  private _progress: Progress;
  private _protectCount = 0;
  private _promise = new ManualPromise<void>();

  constructor(progress: Progress) {
    this._progress = progress;
    this.retain();
  }

  waitFor(): PromiseLike<void> {
    this.release();
    return this._progress.race(this._promise);
  }

  addFrameNavigation(frame: Frame) {
    // Auto-wait top-level navigations only.
    if (frame.parentFrame())
      return;
    this.retain();
    const waiter = helper.waitForEvent(this._progress, frame, Frame.Events.InternalNavigation, (e: NavigationEvent) => {
      if (!e.isPublic)
        return false;
      if (!e.error && this._progress)
        this._progress.log(`  navigated to "${frame._url}"`);
      return true;
    });
    LongStandingScope.raceMultiple([
      frame._page.openScope,
      frame._detachedScope,
    ], waiter.promise).catch(() => {}).finally(() => {
      waiter.dispose();
      this.release();
    });
  }

  retain() {
    ++this._protectCount;
  }

  release() {
    --this._protectCount;
    if (!this._protectCount)
      this._promise.resolve();
  }
}

function verifyLifecycle(name: string, waitUntil: types.LifecycleEvent): types.LifecycleEvent {
  if (waitUntil as unknown === 'networkidle0')
    waitUntil = 'networkidle';
  if (!types.kLifecycleEvents.has(waitUntil))
    throw new Error(`${name}: expected one of (load|domcontentloaded|networkidle|commit)`);
  return waitUntil;
}

function renderUnexpectedValue(expression: string, received: any): string {
  if (expression === 'to.match.aria')
    return received ? received.raw : received;
  return received;
}
