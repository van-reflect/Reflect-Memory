# Reflect Memory Chrome Extension

Your AI tools share one memory. Tell one, they all know.

## Supported AI Tools

- ChatGPT (chatgpt.com)
- Claude (claude.ai)
- Gemini (gemini.google.com)
- Grok (grok.com)
- Perplexity (perplexity.ai)

## How It Works

The extension uses a "Priming Message" architecture that makes the AI genuinely already know your context, rather than injecting text into your prompts.

1. **When you open a new conversation** on any supported AI site, the extension detects the empty chat and sends a brief priming message containing your Reflect Memory context. The AI processes it and responds with "Ready."

2. **Both the priming message and response are hidden** from view by the extension. By the time you start typing, the AI already has your context in its conversation history. It knows your projects, preferences, and recent work without you saying a word.

3. **As you chat**, the extension passively captures meaningful exchanges and writes them back to Reflect Memory. Next time you open a different AI tool, that context is already there.

No buttons. No commands. No visible injection. The AI just knows.

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
  popup.html / popup.js  - One-time setup UI for agent key
  content-scripts/
    shared.js            - Core: priming message, memory capture, vendor adapter interface
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
- The priming message is hidden from view and never stored in your conversation exports
