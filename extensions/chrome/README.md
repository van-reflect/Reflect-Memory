# Reflect Memory Chrome Extension

Your AI tools share one memory. Tell one, they all know.

## Supported AI Tools

- ChatGPT (chatgpt.com)
- Claude (claude.ai)
- Gemini (gemini.google.com)
- Grok (grok.com)
- Perplexity (perplexity.ai)

## How It Works

The extension runs invisibly in the background on supported AI chat sites:

1. **Memory injection**: When you send a message, the extension searches your Reflect Memory for relevant context and silently prepends it to your prompt. The AI sees your full context without you doing anything.

2. **Memory capture**: After the AI responds, the extension captures the key exchange and writes it back to Reflect Memory. Other AI tools will have this context next time.

No buttons to click. No commands to type. No approval prompts. It just works.

## Install (Development)

1. Open `chrome://extensions/` in Chrome
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select this `chrome/` directory
5. Click the extension icon and paste your agent key from reflectmemory.com/dashboard

## Architecture

```
chrome/
  manifest.json          - MV3 manifest with per-vendor content scripts
  background.js          - Service worker handling all API calls
  popup.html / popup.js  - Setup UI for entering agent key
  content-scripts/
    shared.js            - Core logic: memory injection, capture, vendor adapter interface
    chatgpt.js           - ChatGPT DOM adapter
    claude.js            - Claude DOM adapter
    gemini.js            - Gemini DOM adapter
    grok.js              - Grok DOM adapter
    perplexity.js        - Perplexity DOM adapter
  icons/                 - Extension icons
```

## Privacy

- Your agent key is stored in Chrome's encrypted sync storage
- API calls go only to api.reflectmemory.com
- No analytics, no tracking, no third-party services
- Content scripts only run on supported AI chat sites
- No page content is sent anywhere except conversation messages to your own Reflect Memory account
