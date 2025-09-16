/**
 * Playwright CRX External API
 *
 * This script provides an easy-to-use API for interacting with the Playwright CRX extension
 * from other extensions, web pages, or native applications.
 */

(function() {
  'use strict';

  const EXTENSION_ID = 'knkcialnebkmaekkldmepcoidehocoje';

  class PlaywrightCRXAPI {
    constructor() {
      this.connected = false;
      this.messageId = 0;
      this.pendingRequests = new Map();
    }

    // Generate unique message ID
    generateId() {
      return `msg_${++this.messageId}_${Date.now()}`;
    }

    // Send message to extension
    async sendMessage(type, method = null, params = {}) {
      return new Promise((resolve, reject) => {
        const id = this.generateId();
        const message = { type, method, params, id };

        // Store the promise resolvers
        this.pendingRequests.set(id, { resolve, reject });

        // Clean up after timeout
        setTimeout(() => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            reject(new Error('Request timeout'));
          }
        }, 30000);

        // Send message to extension
        chrome.runtime.sendMessage(EXTENSION_ID, message, (response) => {
          if (chrome.runtime.lastError) {
            this.pendingRequests.delete(id);
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          const request = this.pendingRequests.get(id);
          if (request) {
            this.pendingRequests.delete(id);
            if (response.error) {
              request.reject(new Error(response.error));
            } else {
              request.resolve(response.result);
            }
          }
        });
      });
    }

    // Test connection to extension
    async ping() {
      try {
        const result = await this.sendMessage('ping');
        return result;
      } catch (error) {
        throw new Error(`Extension not available: ${error.message}`);
      }
    }

    // Connect to CRX
    async connect() {
      const result = await this.sendMessage('connect');
      this.connected = result.crxReady;
      return result;
    }

    // Disconnect from CRX
    async disconnect() {
      const result = await this.sendMessage('disconnect');
      this.connected = false;
      return result;
    }

    // Attach to all tabs
    async attachAll(options = {}) {
      return await this.sendMessage('crx', 'attachAll', options);
    }

    // Attach to specific tab
    async attach(tabId) {
      return await this.sendMessage('crx', 'attach', { tabId });
    }

    // Create new page
    async newPage(options = {}) {
      return await this.sendMessage('crx', 'newPage', options);
    }

    // Detach from tab
    async detach(tabId) {
      return await this.sendMessage('crx', 'detach', { tabId });
    }

    // Execute JavaScript code
    async evaluate(code, target = {}) {
      return await this.sendMessage('crx', 'evaluate', {
        code,
        ...target
      });
    }

    // Click element
    async click(selector, target = {}) {
      return await this.sendMessage('crx', 'click', {
        selector,
        ...target
      });
    }

    // Fill input
    async fill(selector, value, target = {}) {
      return await this.sendMessage('crx', 'fill', {
        selector,
        value,
        ...target
      });
    }

    // Get all attached pages
    async getPages() {
      return await this.sendMessage('crx', 'getPages');
    }

    // Current tab helper
    async getCurrentTab() {
      return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (tabs.length > 0) {
            resolve(tabs[0]);
          } else {
            reject(new Error('No active tab found'));
          }
        });
      });
    }

    // High-level helper: operate on current tab
    async onCurrentTab() {
      const tab = await this.getCurrentTab();
      return {
        tabId: tab.id,
        click: (selector) => this.click(selector, { tabId: tab.id }),
        fill: (selector, value) => this.fill(selector, value, { tabId: tab.id }),
        evaluate: (code) => this.evaluate(code, { tabId: tab.id }),
        attach: () => this.attach(tab.id),
        detach: () => this.detach(tab.id)
      };
    }

    // WebSocket communication methods for fast Electron integration

    // Connect to Electron app via WebSocket
    async connectWebSocket() {
      return await this.sendMessage('websocket', null, { action: 'connect' });
    }

    // Disconnect from Electron app WebSocket
    async disconnectWebSocket() {
      return await this.sendMessage('websocket', null, { action: 'disconnect' });
    }

    // Check WebSocket connection status
    async webSocketStatus() {
      return await this.sendMessage('websocket', null, { action: 'status' });
    }

    // Send raw message via WebSocket
    async sendWebSocketMessage(type, data = {}) {
      return await this.sendMessage('websocket', null, {
        action: 'send',
        type,
        data
      });
    }

    // Send CRX command via WebSocket (faster than native messaging)
    async sendCRXWebSocket(command, params = {}) {
      return await this.sendMessage('websocket', null, {
        action: 'crx',
        command,
        commandParams: params
      });
    }
  }

  // Create global instance
  window.PlaywrightCRX = new PlaywrightCRXAPI();

  // Also expose as a module if available
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlaywrightCRXAPI;
  }

  // Console helper
  console.log('Playwright CRX API loaded. Use window.PlaywrightCRX to interact with the extension.');
  console.log('Example: await PlaywrightCRX.ping()');

})();

// Example usage:
/*

// Test connection
await PlaywrightCRX.ping();

// Connect to CRX
await PlaywrightCRX.connect();

// Work with current tab
const currentTab = await PlaywrightCRX.onCurrentTab();
await currentTab.click('button');
await currentTab.fill('input[type="text"]', 'Hello World');

// Execute custom code
await PlaywrightCRX.evaluate(`
  document.querySelector('h1').textContent = 'Modified by Playwright CRX';
`, { tabId: await PlaywrightCRX.getCurrentTab().then(t => t.id) });

// Get all pages
const pages = await PlaywrightCRX.getPages();
console.log('Attached pages:', pages);

*/