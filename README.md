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