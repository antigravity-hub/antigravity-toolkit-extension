# 🚀 Antigravity Toolkit (`antigravity-toolkit-extension`)

[![GitHub Release](https://img.shields.io/github/v/release/antigravity-hub/antigravity-toolkit-extension?style=flat-square&color=emerald)](https://github.com/antigravity-hub/antigravity-toolkit-extension/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Antigravity%20IDE%20%7C%20Cursor%20%7C%20VS%20Code-purple?style=flat-square)](https://github.com/antigravity-hub/antigravity-toolkit-extension)

> **The all-in-one IDE toolkit for Antigravity: visual conversation history, quota analytics, and instant live account switching without restarting your IDE.**

---

## 🌟 Key Features

### ⚡ 1. Zero-Restart Live Account Switcher
- **Instant Hot-Swap**: Switches active Google / Antigravity accounts directly in Language Server memory via internal IPC.
- **No Window Reboots**: Say goodbye to closing and relaunching your editor just to change credentials.
- **Readiness Gate**: Kubernetes-style probe verifies Language Server availability before dispatching tokens, preventing stale-credential 401s.

### 📜 2. Visual Conversation History & Transcript Inspector
- **Session Explorer**: Browse past conversations directly in the IDE sidebar, grouped chronologically with step counts and previews.
- **Deep Thought Tracing**: Inspect internal `<thought>` reasoning blocks and agent trajectories.
- **1-Click Open**: Launch full `.jsonl` transcripts directly inside the editor.

### 📊 3. Live Quota & Token Budget Dashboard
- **Model Meters**: Color-coded progress bars for Gemini 3.7 Flash, Pro, and Thinking variants.
- **Reset Countdown Timers**: Real-time tracking of 5-hour rolling recovery and weekly usage limits.
- **Status Bar Integration**: Keeps your active account email and quota availability in plain sight.

### 🛡️ 4. Seamless Antigravity Shield Sync
- Automatically detects your local [Antigravity Shield](https://github.com/antigravity-hub/Antigravity-Shield) daemon on `http://127.0.0.1:8765`.
- 1-click synchronization of your accounts pool, proxy routing, and quotas.

---

## 📦 Installation

### Option 1: Install from VSIX (Recommended)
1. Download the latest `.vsix` release from [Releases](https://github.com/antigravity-hub/antigravity-toolkit-extension/releases).
2. Open Antigravity IDE, Cursor, or VS Code.
3. Open the Extensions tab (`Ctrl+Shift+X` / `Cmd+Shift+X`), click the `...` menu in the top-right, and choose **Install from VSIX...**.
4. Select the downloaded `.vsix` file.

### Option 2: Command Line Installation
```bash
# In Antigravity IDE
antigravity --install-extension antigravity-toolkit-1.0.0.vsix

# In Cursor
cursor --install-extension antigravity-toolkit-1.0.0.vsix

# In standard VS Code
code --install-extension antigravity-toolkit-1.0.0.vsix
```

---

## 🛠️ Development & Building

```bash
# Clone the repository
git clone https://github.com/antigravity-hub/antigravity-toolkit-extension.git
cd antigravity-toolkit-extension

# Install dependencies
npm install

# Build with esbuild
npm run build

# Package into a .vsix bundle
npm run package
```

---

## 📄 License

MIT © [antigravity-hub](https://github.com/antigravity-hub)
