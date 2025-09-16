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

// Pure API extension - no TodoMVC specific code

// Global CRX instance for external API
let globalCrxApp: any = null;
// let nativePort: chrome.runtime.Port | null = null;
// let wsServer: WebSocket | null = null;

// External API interface
interface ExternalMessage {
  type: 'crx' | 'ping' | 'connect' | 'disconnect';
  method?: string;
  params?: any;
  id?: string;
}

interface ExternalResponse {
  id?: string;
  result?: any;
  error?: string;
}

// Initialize CRX if needed
async function ensureCrxApp() {
  if (!globalCrxApp) {
    const { crx } = await import('playwright-crx');
    globalCrxApp = await crx.start({ slowMo: 500 });
  }
  return globalCrxApp;
}

// Handle external messages from other extensions or native apps
chrome.runtime.onMessageExternal.addListener(
  (message: ExternalMessage, sender, sendResponse) => {
    console.log('[External] Received message:', message);

    // Check if this is a WebSocket command
    if (message.method === 'websocket') {
      handleWebSocketCommand(message, sender)
        .then(sendResponse)
        .catch(error => {
          console.error('[External] WebSocket command error:', error);
          sendResponse({ error: error.message });
        });
      return true;
    }

    // Handle regular external messages
    handleExternalMessage(message, sender).then(sendResponse).catch(error => {
      sendResponse({ error: error.message });
    });
    return true; // Keep message channel open for async response
  }
);

// Handle messages from the extension's own content scripts
chrome.runtime.onMessage.addListener(
  (message: ExternalMessage, sender, sendResponse) => {
    handleExternalMessage(message, sender).then(sendResponse).catch(error => {
      sendResponse({ error: error.message });
    });
    return true;
  }
);

// Handle external connection requests
chrome.runtime.onConnectExternal.addListener((port) => {
  port.onMessage.addListener(async (message: ExternalMessage) => {
    try {
      const response = await handleExternalMessage(message, { id: port.sender?.id });
      port.postMessage(response);
    } catch (error) {
      port.postMessage({ error: (error as Error).message });
    }
  });
});

// Native messaging handler
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'playwright-crx-native') {
    // nativePort = port;
    port.onMessage.addListener(async (message: ExternalMessage) => {
      try {
        const response = await handleExternalMessage(message, { id: 'native' });
        port.postMessage(response);
      } catch (error) {
        port.postMessage({ error: (error as Error).message });
      }
    });

    port.onDisconnect.addListener(() => {
      // nativePort = null;
      console.log('[Native] Native messaging port disconnected');
    });
  }
});

// Core message handler
async function handleExternalMessage(message: ExternalMessage, _sender: any): Promise<ExternalResponse> {
  const startTime = performance.now();
  const response: ExternalResponse = { id: message.id };

  try {
    switch (message.type) {
      case 'ping':
        // Ultra-fast ping response
        response.result = {
          status: 'ok',
          extensionId: chrome.runtime.id,
          version: chrome.runtime.getManifest().version,
          latency: performance.now() - startTime
        };
        break;

      case 'connect':
        await ensureCrxApp();
        response.result = { status: 'connected', crxReady: !!globalCrxApp };
        break;

      case 'disconnect':
        if (globalCrxApp) {
          await globalCrxApp.close();
          globalCrxApp = null;
        }
        response.result = { status: 'disconnected' };
        break;

      case 'crx':
        const crxApp = await ensureCrxApp();
        response.result = await handleCrxMethod(crxApp, message.method!, message.params);
        break;

      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  } catch (error) {
    response.error = (error as Error).message;
    console.error('[External] Message handling error:', error);
  }

  // Add timing information for performance monitoring
  const totalTime = performance.now() - startTime;
  if (response.result && typeof response.result === 'object') {
    response.result._timing = {
      total: Math.round(totalTime * 100) / 100,
      type: message.type
    };
  }

  console.log(`[External] ${message.type} completed in ${totalTime.toFixed(2)}ms`);
  return response;
}

// Handle CRX method calls
async function handleCrxMethod(crxApp: any, method: string, params: any = {}) {
  switch (method) {
    case 'attachAll':
      const pages = await crxApp.attachAll(params);
      return { pages: pages.map((p: any) => ({ url: p.url() })) };

    case 'attach':
      if (!params.tabId) throw new Error('tabId required for attach');
      const page = await crxApp.attach(params.tabId);
      return { pageUrl: page.url() };

    case 'newPage':
      const newPage = await crxApp.newPage(params);
      return { pageUrl: newPage.url() };

    case 'detach':
      if (params.tabId) {
        await crxApp.detach(params.tabId);
      } else if (params.pageUrl) {
        const pages = await crxApp.attachAll();
        const page = pages.find((p: any) => p.url() === params.pageUrl);
        if (page) await crxApp.detach(page);
      }
      return { status: 'detached' };

    case 'evaluate':
      if (!params.code) throw new Error('code required for evaluate');
      if (!params.tabId && !params.pageUrl) throw new Error('tabId or pageUrl required');

      let targetPage;
      if (params.tabId) {
        targetPage = await crxApp.attach(params.tabId);
      } else {
        const pages = await crxApp.attachAll();
        targetPage = pages.find((p: any) => p.url() === params.pageUrl);
      }

      if (!targetPage) throw new Error('Page not found');

      const result = await targetPage.evaluate(params.code);
      return { result };

    case 'click':
      if (!params.selector) throw new Error('selector required for click');
      if (!params.tabId && !params.pageUrl) throw new Error('tabId or pageUrl required');

      let clickPage;
      if (params.tabId) {
        clickPage = await crxApp.attach(params.tabId);
      } else {
        const pages = await crxApp.attachAll();
        clickPage = pages.find((p: any) => p.url() === params.pageUrl);
      }

      if (!clickPage) throw new Error('Page not found');

      await clickPage.locator(params.selector).click();
      return { status: 'clicked' };

    case 'fill':
      if (!params.selector) throw new Error('selector required for fill');
      if (!params.value) throw new Error('value required for fill');
      if (!params.tabId && !params.pageUrl) throw new Error('tabId or pageUrl required');

      let fillPage;
      if (params.tabId) {
        fillPage = await crxApp.attach(params.tabId);
      } else {
        const pages = await crxApp.attachAll();
        fillPage = pages.find((p: any) => p.url() === params.pageUrl);
      }

      if (!fillPage) throw new Error('Page not found');

      await fillPage.locator(params.selector).fill(params.value);
      return { status: 'filled' };

    case 'getPages':
      const allPages = await crxApp.attachAll();
      return { pages: allPages.map((p: any) => ({ url: p.url() })) };

    default:
      throw new Error(`Unknown CRX method: ${method}`);
  }
}

// Extension is now pure API - no action click handler needed
// All functionality exposed via external messaging and WebSocket

// WebSocket client for fast communication with Electron app
class ElectronWebSocketClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private pendingRequests = new Map<string, {resolve: Function, reject: Function, timestamp: number}>();
  private messageId = 0;
  private pingInterval: NodeJS.Timeout | null = null;
  private responseTimeouts = new Map<string, NodeJS.Timeout>();
  private lastPongTime = 0;
  private connectionStartTime = 0;
  private messageQueue: Array<{message: any, resolve: Function, reject: Function}> = [];
  private batchTimeout: NodeJS.Timeout | null = null;
  private batchSize = 10;
  private batchDelayMs = 5;

  constructor(private url: string = 'ws://localhost:9876') {}

  async connect(): Promise<boolean> {
    if (this.connected) return true;

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log('[WebSocket] Connected to Electron app');
          this.connected = true;
          this.reconnectAttempts = 0;
          this.connectionStartTime = Date.now();
          this.startKeepAlive();
          resolve(true);
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            console.error('[WebSocket] Error parsing message:', error);
          }
        };

        this.ws.onclose = () => {
          console.log('[WebSocket] Disconnected from Electron app');
          this.connected = false;
          this.ws = null;
          this.stopKeepAlive();
          this.scheduleReconnect();
        };

        this.ws.onerror = (error) => {
          console.error('[WebSocket] Connection error:', error);
          this.connected = false;
          resolve(false);
        };

        // Set a timeout for connection
        setTimeout(() => {
          if (!this.connected) {
            this.ws?.close();
            resolve(false);
          }
        }, 5000);

      } catch (error) {
        console.error('[WebSocket] Failed to create connection:', error);
        resolve(false);
      }
    });
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

      setTimeout(() => {
        this.connect();
      }, delay);
    } else {
      console.log('[WebSocket] Max reconnection attempts reached');
    }
  }

  private handleMessage(message: any) {
    // Handle pong responses for latency monitoring
    if (message.type === 'pong') {
      this.lastPongTime = Date.now();
      const latency = this.lastPongTime - message.timestamp;
      console.log(`[WebSocket] Latency: ${latency}ms`);
      return;
    }

    if (message.id && this.pendingRequests.has(message.id)) {
      const { resolve, reject, timestamp } = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);

      // Clear timeout
      if (this.responseTimeouts.has(message.id)) {
        clearTimeout(this.responseTimeouts.get(message.id)!);
        this.responseTimeouts.delete(message.id);
      }

      const latency = Date.now() - timestamp;
      console.log(`[WebSocket] Request ${message.id} completed in ${latency}ms`);

      if (message.error) {
        reject(new Error(message.error));
      } else {
        resolve(message.result || message);
      }
    }
  }

  async sendMessage(type: string, data: any = {}): Promise<any> {
    if (!this.connected || !this.ws) {
      throw new Error('WebSocket not connected');
    }

    const id = `ws_${++this.messageId}`;
    const timestamp = Date.now();
    const message = { id, type, timestamp, ...data };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, timestamp });

      // Send message immediately without serialization delay
      this.ws!.send(JSON.stringify(message));

      // Set optimized timeout with cleanup
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          this.responseTimeouts.delete(id);
          reject(new Error(`Request timeout after 10s`));
        }
      }, 10000); // Reduced timeout to 10s

      this.responseTimeouts.set(id, timeout);
    });
  }

  disconnect() {
    this.stopKeepAlive();
    if (this.ws) {
      this.ws.close();
      this.connected = false;
      this.ws = null;
    }
    // Clear all pending requests
    this.pendingRequests.clear();
    this.responseTimeouts.forEach(timeout => clearTimeout(timeout));
    this.responseTimeouts.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.pingInterval = setInterval(() => {
      if (this.connected && this.ws) {
        const pingTime = Date.now();
        this.ws.send(JSON.stringify({
          type: 'ping',
          timestamp: pingTime,
          id: `ping_${this.messageId++}`
        }));
      }
    }, 30000); // Ping every 30 seconds
  }

  private stopKeepAlive() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  getLatency(): number {
    return this.lastPongTime > 0 ? this.lastPongTime - this.connectionStartTime : -1;
  }

  getConnectionStats() {
    return {
      connected: this.connected,
      connectionTime: this.connectionStartTime,
      lastPong: this.lastPongTime,
      pendingRequests: this.pendingRequests.size,
      reconnectAttempts: this.reconnectAttempts,
      queuedMessages: this.messageQueue.length
    };
  }

  // Batch messaging for bulk operations
  async sendBatch(messages: Array<{type: string, data?: any}>): Promise<any[]> {
    if (!this.connected || !this.ws) {
      throw new Error('WebSocket not connected');
    }

    const batchId = `batch_${++this.messageId}`;
    const timestamp = Date.now();
    const promises: Promise<any>[] = [];

    const batchMessage = {
      id: batchId,
      type: 'batch',
      timestamp,
      batch: messages.map((msg, index) => ({
        id: `${batchId}_${index}`,
        type: msg.type,
        ...msg.data
      }))
    };

    // Create promises for each message in batch
    messages.forEach((_, index) => {
      const itemId = `${batchId}_${index}`;
      promises.push(new Promise((resolve, reject) => {
        this.pendingRequests.set(itemId, { resolve, reject, timestamp });

        const timeout = setTimeout(() => {
          if (this.pendingRequests.has(itemId)) {
            this.pendingRequests.delete(itemId);
            this.responseTimeouts.delete(itemId);
            reject(new Error(`Batch item ${index} timeout`));
          }
        }, 10000);

        this.responseTimeouts.set(itemId, timeout);
      }));
    });

    // Send the entire batch as one message
    this.ws.send(JSON.stringify(batchMessage));
    console.log(`[WebSocket] Sent batch of ${messages.length} messages`);

    return Promise.all(promises);
  }

  // Queue messages for automatic batching
  async sendQueued(type: string, data: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const message = { type, ...data };
      this.messageQueue.push({ message, resolve, reject });

      if (this.messageQueue.length >= this.batchSize) {
        this.flushQueue();
      } else if (!this.batchTimeout) {
        this.batchTimeout = setTimeout(() => {
          this.flushQueue();
        }, this.batchDelayMs);
      }
    });
  }

  private flushQueue() {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }

    if (this.messageQueue.length === 0) return;

    const batch = this.messageQueue.splice(0);
    const messages = batch.map(item => ({ type: item.message.type, data: item.message }));

    this.sendBatch(messages).then(results => {
      batch.forEach((item, index) => {
        item.resolve(results[index]);
      });
    }).catch(error => {
      batch.forEach(item => {
        item.reject(error);
      });
    });
  }
}

// Global WebSocket client instance
const electronClient = new ElectronWebSocketClient();

// Auto-connect on startup
electronClient.connect().then(connected => {
  if (connected) {
    console.log('[WebSocket] Successfully connected to Electron app');
  } else {
    console.log('[WebSocket] Failed to connect to Electron app, will retry');
  }
});

// WebSocket command handler for external messages
async function handleWebSocketCommand(message: ExternalMessage, _sender: chrome.runtime.MessageSender): Promise<any> {
  const { params } = message;

  switch (params?.action) {
    case 'connect':
      const connected = await electronClient.connect();
      return { connected, status: connected ? 'connected' : 'failed' };

    case 'disconnect':
      electronClient.disconnect();
      return { status: 'disconnected' };

    case 'status':
      return {
        connected: electronClient.isConnected(),
        status: electronClient.isConnected() ? 'connected' : 'disconnected'
      };

    case 'send':
      if (!params.type) {
        throw new Error('WebSocket send requires type parameter');
      }
      const result = await electronClient.sendMessage(params.type, params.data || {});
      return { result };

    case 'crx':
      // Forward CRX command through WebSocket
      if (!params.command) {
        throw new Error('CRX command requires command parameter');
      }
      const crxResult = await electronClient.sendMessage('crx', {
        method: params.command,
        params: params.commandParams || {}
      });
      return crxResult;

    default:
      throw new Error(`Unknown WebSocket action: ${params?.action}`);
  }
}
