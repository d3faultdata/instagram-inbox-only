<img width="1280" height="640" alt="inboxonly-open-graph" src="https://github.com/user-attachments/assets/790ea3d1-9faa-442b-a76a-24ac8131d389" />

# IG Inbox Only
A minimal browser extension that forces Instagram to open in your Direct Inbox and blocks all distracting navigation like the feed, explore, reels, or profiles.

This extension is designed for people who only use Instagram for messaging and want a clean, distraction-free experience.

## Features

- Always redirects `instagram.com` to **Direct Inbox**
- Removes feed, reels, explore, and profile navigation
- Greys out and disables all non-DM links
- Hides the main navigation bar completely
- Works on Chrome, Brave, and all Chromium-based browsers
- Zero tracking, zero data collection, fully local

## How it works

### 1. Network-level redirect
A background rule intercepts every Instagram page load and forces it to:

```
https://www.instagram.com/direct/inbox/
```

### 2. UI cleanup
A content script removes distractions by:

- Hiding the main navigation bar
- Blocking all links that lead outside DMs
- Allowing only `/direct/...` routes
- Greying out disabled links for clarity

## Installation (Developer Mode)

1. Download or clone the repository
2. Open:
   - `chrome://extensions`
   - or `brave://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the folder containing `manifest.json`

## Privacy

This extension does **not** collect any data.

- No analytics  
- No external requests  
- No tracking  
- Fully local execution  

## Files in this extension

- `manifest.json` — permissions and config
- `background.js` — network inbox redirect
- `content.js` — UI cleanup and link blocking

## License

MIT
