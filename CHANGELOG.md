# Changelog

All notable changes to Kladde. Versions follow [Semantic Versioning](https://semver.org), commit messages
[Conventional Commits](https://www.conventionalcommits.org).
## [0.1.0](https://github.com/LukasDoubleU/Kladde/releases/tag/v0.1.0) – 2026-10-27

### 🚀 Features

- **files:** Save files crash-safely ([c6825fe](https://github.com/LukasDoubleU/Kladde/commit/c6825febf537b2574803f6429a9ed0e32b11ebb7))
- **session:** Keep backup versions and support an isolated profile ([01008bd](https://github.com/LukasDoubleU/Kladde/commit/01008bdcac5d22e8291a56d0679ba5019e4c8a66))
- **keys:** Delete the current line with Ctrl+D ([d371cf3](https://github.com/LukasDoubleU/Kladde/commit/d371cf34b5812ea591c379e146c567ceafa71b0b))
- **keys:** Reveal the current file in Explorer with Alt+Shift+W ([c553c48](https://github.com/LukasDoubleU/Kladde/commit/c553c48c421948090cb3dc1ed65717f206bd61dd))
- **session:** Restore an older backup of a tab ([3efe7da](https://github.com/LukasDoubleU/Kladde/commit/3efe7dad8ad34366839ebd733869542e4b7d3f4c))
- **preview:** Render Mermaid diagrams and KaTeX math ([8ba3485](https://github.com/LukasDoubleU/Kladde/commit/8ba3485707ccf45cd7d67adc283e2d23f066b443))
- **compare:** Compare two tabs, a tab with its file on disk or the clipboard ([11f861b](https://github.com/LukasDoubleU/Kladde/commit/11f861b72d46554334f186ba6e65410e934b518f))
- **format:** Format by language, XML, SQL, CSS, YAML, JS/TS, HTML and more ([70178c7](https://github.com/LukasDoubleU/Kladde/commit/70178c72469b43064ac5d00eec939723595ba105))
- **integration:** Register Kladde with Windows file associations ([a596dc3](https://github.com/LukasDoubleU/Kladde/commit/a596dc3da73a5dfd1def336e61a50186755eff54))
- **ui:** Offer Kladde as default editor and add integration commands ([9decf99](https://github.com/LukasDoubleU/Kladde/commit/9decf9983cb27ea88835f25573127a1538c51b81))

### 🐛 Bug fixes

- **session:** Back up while typing instead of after a pause ([6fc581b](https://github.com/LukasDoubleU/Kladde/commit/6fc581b8df8347975cbce8f1488bdfadd5802793))

### 📚 Documentation

- Describe releases and commit conventions, add CLAUDE.md ([84ddcc4](https://github.com/LukasDoubleU/Kladde/commit/84ddcc46b377410aefe1353f76cc4b8d1047c974))
- Describe the data-loss guarantees ([f69ac19](https://github.com/LukasDoubleU/Kladde/commit/f69ac198db5238dd7644d4c813337d85b32d4ecb))

### 🎨 Styling

- **editor:** Theme the search and replace panel ([9fb8c8a](https://github.com/LukasDoubleU/Kladde/commit/9fb8c8afbd07a786fe7e4d47a35e6bd83dfbfc07))

### 🧪 Tests

- Add an end-to-end harness that drives the app through CDP ([5516c11](https://github.com/LukasDoubleU/Kladde/commit/5516c118d932d93c2924ab2ea7f5dbf4bfc7bf73))
- End-to-end tests for hot exit and saving, run in CI ([f382170](https://github.com/LukasDoubleU/Kladde/commit/f38217020cc821324d15074b6358c353e04d5048))
- **preview:** Cover diagrams, math and error boxes, document them ([778fa4d](https://github.com/LukasDoubleU/Kladde/commit/778fa4d122cc460f9229d1966dc576193a867ef2))
- Emulate window focus in the e2e harness ([d2d67f6](https://github.com/LukasDoubleU/Kladde/commit/d2d67f6249bec251b7e07c3f47cd71e73ede81d3))
- **format:** Cover Shift+Alt+F end to end ([a60f063](https://github.com/LukasDoubleU/Kladde/commit/a60f06387c6da6c51ae14839753cd6575feeee6e))
- **integration:** Cover the offer, registration and cleanup end to end ([ab83106](https://github.com/LukasDoubleU/Kladde/commit/ab83106c1e53c0c08f6e2d6702039ce1b00dff09))

### 🏗️ Build and CI

- Enforce Conventional Commits with a commit-msg hook ([0730f9d](https://github.com/LukasDoubleU/Kladde/commit/0730f9df20480e61420e4c7561793f631036caa6))
- Check commit messages, types and Rust tests on every push ([a5242d5](https://github.com/LukasDoubleU/Kladde/commit/a5242d5f929c495a26fe26669e7067e50616d521))
- **release:** Create releases on demand with changelog and exe files ([026ac02](https://github.com/LukasDoubleU/Kladde/commit/026ac02603c0c0525d321c7adb8cb5b4e66ce8ea))
- **installer:** Remove file associations when uninstalling ([3832b73](https://github.com/LukasDoubleU/Kladde/commit/3832b73e2225c698e30c03d201742a4eed50a757))

### 📝 Other changes

- Initial version of Kladde ([d9f8ec3](https://github.com/LukasDoubleU/Kladde/commit/d9f8ec318ad0dde0445529174ae84b077bcb6daf))
- Use Catppuccin Mocha with Rosewater accent as the default theme ([be061f5](https://github.com/LukasDoubleU/Kladde/commit/be061f5fa85cb1a5be671026f9a6b520adb34673))
- Add shortcuts that mouse gesture tools send ([e73173a](https://github.com/LukasDoubleU/Kladde/commit/e73173aba6e36c8a4730391e0060b5bc2c0cf0e3))
- Default to JetBrains Mono and Inter, with ligatures ([a2e2b9d](https://github.com/LukasDoubleU/Kladde/commit/a2e2b9d73ad3cc10171b8bd8c1dd07e9b1de1a0f))
- Add motivation to README ([7235201](https://github.com/LukasDoubleU/Kladde/commit/7235201a5551751a7e4581b551a25d95a537af98))
- New app icon: Catppuccin gradient K ([87bfeab](https://github.com/LukasDoubleU/Kladde/commit/87bfeaba41b2201ceb0cef9548938ae96c251d4d))
- Add JSON formatting, spell checking and instant backups on focus loss ([771668b](https://github.com/LukasDoubleU/Kladde/commit/771668b7fd3d10386bdf5dc975063e0726f7db4a))
- Write the README, add the MIT license and a screenshot ([c6115d0](https://github.com/LukasDoubleU/Kladde/commit/c6115d04c4e67dfb931db05a31fdf83385dd4cfd))
