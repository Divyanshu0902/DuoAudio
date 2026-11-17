# Contributing to DuoAudio

Thank you for your interest in contributing to DuoAudio! We welcome bug reports, feature requests, documentation improvements, and pull requests.

---

## 🛠️ Development Environment

### Prerequisites
- **Operating System:** Windows 11 (64-bit)
- **Runtime:** Node.js (v22.x LTS recommended) and npm
- **C++ Compiler:** MinGW-w64 GCC (`g++`) with C++17 support

### Local Setup
```powershell
# 1. Fork and clone the repository
git clone https://github.com/Divyanshu0902/DuoAudio.git
cd DuoAudio

# 2. Install dependencies
npm install

# 3. Compile native C++ helper
scripts\build-native-helper.bat

# 4. Build UI assets and start dev environment
npm run build:ui
npm run dev
```

---

## 🧪 Testing

Before submitting a pull request, run the test suites to ensure zero regressions:

```powershell
# Core unit & integration tests
node test/test_zero_config_default.js
node test/test_native_endpoint.js
node test/test_mute_lifecycle.js
node test/test_native_integration.js
node test/test_audio_resilience.js
node test/test_desktop_integration.js

# UI build check
npm run build:ui
```

---

## 📐 Project Architecture Guidelines

1. **Native Helper (`duoaudio_endpoint.exe`):**
   - All Windows Core Audio COM interactions (`IPolicyConfig`, `IMMDeviceEnumerator`) belong in `src/native/duoaudio_endpoint.cpp`.
   - Never introduce PowerShell scripts (`.ps1`) or runtime script compilation, as they trigger antivirus false-positives.

2. **Audio Runner Isolation:**
   - Real-time audio loopback capture and streaming logic runs in an isolated child process (`src/audio_runner.js`), decoupled from Electron.

3. **Code Style:**
   - Clean, readable modern JavaScript (ES6+).
   - Descriptive variable names, structured error handling, and zero swallowed exceptions.

---

## 🚀 Submitting Changes

1. Create a feature branch:
   ```powershell
   git checkout -b feature/my-new-feature
   ```
2. Commit your changes with clear, descriptive commit messages.
3. Push to your fork and submit a Pull Request against `main`.
4. Please describe your changes, testing steps, and Windows audio devices tested.
