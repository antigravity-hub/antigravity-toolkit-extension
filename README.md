# 🚀 Antigravity Toolkit (`antigravity-toolkit-extension`)

[![GitHub Release](https://img.shields.io/github/v/release/antigravity-hub/antigravity-toolkit-extension?style=flat-square&color=emerald)](https://github.com/antigravity-hub/antigravity-toolkit-extension/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Antigravity%20IDE%20%7C%20Cursor%20%7C%20VS%20Code-purple?style=flat-square)](https://github.com/antigravity-hub/antigravity-toolkit-extension)

> **The all-in-one IDE toolkit for Antigravity: visual conversation history, quota analytics, and instant live account switching without restarting your IDE.**

---

## 🌟 Key Features (v2.0)

### ⚡ 1. Autonomous Smart Account Rotation Engine (New in v2.0)
- **Zero-Touch Session Switcher**: Automatically switches to the highest-quota standby account whenever the active session drops below 1–2% remaining quota, or the 5-hour rolling reset window reaches expiration.
- **Anti-Thrashing Cooldown**: Built-in 3-minute hysteresis protection to ensure smooth workflow transitions without session ping-ponging.
- **Background Quota Sentinel**: Continuously evaluates multi-account telemetry every 30 seconds and notifies you seamlessly when rotation happens.

### 🌌 2. Cyber-Glass Obsidian HUD & Live Radial Gauges
- **Awwwards/Linear-Grade Aesthetic**: Obsidian dark surfaces (`#0a0d14`), double-bezel concentric cards, and luminous cyan/emerald/amber/ruby neon accents.
- **Animated Radial SVG Rings**: Real-time progress meters with animated glowing stroke filters for each model (Gemini 3.7 Flash, Thinking, Pro).
- **DOM Live Countdown Tickers**: Second-by-second countdown clock ticking down to exact 5-hour rolling and weekly recovery points.
- **Animated Micro-Interactions**: Dynamic reactor SVG cores, radar sweep beacon, and haptic button physics.

### 🔄 3. Multi-Session Switchboard Cards
- **Instant 1-Click Hot-Swap**: Switches active Google / Antigravity accounts directly in Language Server memory via internal IPC without restarting your IDE window.
- **Live Health Capacity Bars**: Immediate visual indication of each account's aggregated capacity and standby status (Active ⚡, Ready 🟢, Low 🟡, Depleted 🔴).

### 📜 4. Visual Conversation History & Transcript Inspector
- **Session Explorer**: Browse past conversations directly in the IDE sidebar, grouped chronologically with step counts and previews.
- **Deep Thought Tracing**: Inspect internal `<thought>` reasoning blocks and agent trajectories.
- **1-Click Open**: Launch full `.jsonl` transcripts directly inside the editor.

### 🛡️ 5. Seamless Antigravity Shield Sync
- Automatically detects your local [Antigravity Shield](https://github.com/antigravity-hub/Antigravity-Shield) daemon on `http://127.0.0.1:8045` or `8765`.
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
