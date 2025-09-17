# patchright-crx

> "I can't help with scraping LinkedIn profiles, automating interactions that violate platforms' terms of service, or bypassing anti-bot measures. I can help with legitimate web automation for testing, development, and authorized use cases." - Claude

## About

Patchright-CRX is a Chrome extension that provides programmatic browser automation capabilities through external messaging APIs. Built on the Playwright framework, it enables:

- **External Extension API**: Chrome extensions can communicate via `chrome.runtime.sendMessage` and `chrome.runtime.connect`
- **Native Messaging**: Bi-directional communication with native applications using Chrome's native messaging protocol
- **WebSocket Server**: High-performance real-time communication for ultra-low latency operations
- **Web-Accessible API**: Direct JavaScript API access for web pages through injected scripts
- **Chrome DevTools Protocol**: Fallback support for direct browser control (detectable by anti-bot systems)

The system supports message batching, connection pooling, and TCP optimizations for maximum performance. All communication channels include graceful error handling and automatic retry mechanisms.

Technical implementation uses Manifest V3 service workers with `debugger`, `tabs`, and `nativeMessaging` permissions. The extension operates independently but can integrate with external applications for enhanced functionality.

## Usage Examples

These examples use the web-accessible API (`window.googleads`) exposed by the nativerelay CRX.

```js
// 1) Fast connect (no slow motion by default)
await googleads.connect({ slowMo: 0 });

// Optionally enable slowMo for demo/visibility
await googleads.connect({ slowMo: 200 });

// 2) Toggle WebSocket auto-connect on extension startup
await googleads.setWebSocketAutoConnect(true);  // enable
await googleads.setWebSocketAutoConnect(false); // disable

// 3) Explicit WebSocket connect/disconnect and status
await googleads.connectWebSocket();
await googleads.webSocketStatus();
await googleads.disconnectWebSocket();

// 4) Send a batch of WebSocket messages to reduce overhead
await googleads.sendWebSocketBatch([
  { type: 'ping' },
  { type: 'status' },
]);

// 5) Batch CRX commands over WebSocket for throughput
const { id: tabId } = await googleads.getCurrentTab();
await googleads.sendCRXWebSocketBatch([
  { method: 'click', params: { selector: '#go', tabId } },
  { method: 'fill',  params: { selector: 'input[name=email]', value: 'user@example.com', tabId } },
  { method: 'evaluate', params: { code: 'document.title', tabId } },
]);

// 6) Regular CRX usage (benefits from internal URL cache)
const current = await googleads.onCurrentTab();
await current.click('#submit');
await current.fill('input[type="text"]', 'Hello');
const title = await current.evaluate('document.title');
```

Notes:
- `connect({ slowMo })` restarts the internal CRX session if the value changes.
- WebSocket auto-connect is stored in `chrome.storage.local` and applied on extension startup.
- Timeouts are aligned to 10s for quicker cleanup and consistent behavior.
