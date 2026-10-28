# Changelog

All notable changes to Kladde. Versions follow [Semantic Versioning](https://semver.org), commit messages
[Conventional Commits](https://www.conventionalcommits.org).
## [0.2.0](https://github.com/LukasDoubleU/Kladde/releases/tag/v0.2.0) – 2026-10-28

### 🚀 Features

- **updater:** Add update check and install commands to the core ([1c7f88a](https://github.com/LukasDoubleU/Kladde/commit/1c7f88aa10c0b3ea83209d70cdaa9f34869d1452))
- **updater:** Announce updates with a banner and a command ([9bb1a7c](https://github.com/LukasDoubleU/Kladde/commit/9bb1a7cf09f3a6b0b08ccc8ba1e11244fa77507f))
- **theme:** Ship all Catppuccin flavors, accent colors and a custom theme.css ([5389bf3](https://github.com/LukasDoubleU/Kladde/commit/5389bf3351e961e05167bbac308107898e64c5cc))
- **large:** UTF-16, regex and Unicode search, growing index ([7f85ded](https://github.com/LukasDoubleU/Kladde/commit/7f85ded874893cb450f6ab1f04743a00b963c1bb))
- **large:** Search options, highlighting, following and open in editor ([ca37b8a](https://github.com/LukasDoubleU/Kladde/commit/ca37b8ab6d30605b24ad148fd914258bfe9bfc21))
- **keys:** Bind CodeMirror's editing commands as actions ([16af8ce](https://github.com/LukasDoubleU/Kladde/commit/16af8ce66a3177a74036ab8892f68866309d8c0b))
- **keys:** Keymap presets, chords and a shortcut editor ([a7a1203](https://github.com/LukasDoubleU/Kladde/commit/a7a120323b1c1cb9efecf77bfa858813bdae8528))
- **grammar:** Add a LanguageTool client in the Rust core ([2653f6e](https://github.com/LukasDoubleU/Kladde/commit/2653f6e82c3460b6145bac7f8212dd30b1b4478d))
- **grammar:** Prepare text for LanguageTool and map findings back ([cde7ef8](https://github.com/LukasDoubleU/Kladde/commit/cde7ef84a8b1e5a45577211b60e691cc68132f54))
- **grammar:** Underline LanguageTool findings with quick fixes ([462d6ae](https://github.com/LukasDoubleU/Kladde/commit/462d6aeabf68ece72dfb4aa79a564dedbab77cc9))

### 🐛 Bug fixes

- **updater:** Keep isolated profiles away from the real update server ([a7ff8bb](https://github.com/LukasDoubleU/Kladde/commit/a7ff8bb293f840d3bb5588092938227aed3715c3))
- **grammar:** Color findings from the theme in every flavor ([7566247](https://github.com/LukasDoubleU/Kladde/commit/75662478082cb04ea59a938e1734e40252b927d8))

### 📚 Documentation

- **updater:** Describe updates, the setting and the release secret ([62869b1](https://github.com/LukasDoubleU/Kladde/commit/62869b1e8326e26c6bb70c832ce5c8eaa55fc589))
- **theme:** Document the theme settings and the theme.css variables ([8a114f8](https://github.com/LukasDoubleU/Kladde/commit/8a114f85f955200426d298b822d11d78437f6c32))
- **keys:** Document presets, chords and the shortcut editor ([41b792e](https://github.com/LukasDoubleU/Kladde/commit/41b792e297fbb80fa4705df4dc27318753058c0f))
- **grammar:** Describe grammar checking and its settings ([025d615](https://github.com/LukasDoubleU/Kladde/commit/025d615a8f05d9a7f8392318f91cce80a1968a3d))
- Collect architecture, decisions, testing, workflow and roadmap ([30b2bef](https://github.com/LukasDoubleU/Kladde/commit/30b2befcef70000ccab5193eccdee9241b637f8c))
- Don't push to main while a release runs ([337ee8d](https://github.com/LukasDoubleU/Kladde/commit/337ee8d48780d8b91ad2bf77408349853a5da255))

### 🧪 Tests

- **updater:** Cover banner, portable decision and daily limit end to end ([d64cff0](https://github.com/LukasDoubleU/Kladde/commit/d64cff01916d08aa0d1d065aa0821d20103f55dd))
- **theme:** Cover flavors, accents, theme.css and the Windows mode ([9b3f4a1](https://github.com/LukasDoubleU/Kladde/commit/9b3f4a1e4a9ed2ba5918f6a7169be9277ae5b716))
- **large:** Cover the viewer end to end and document the new features ([8fd2f88](https://github.com/LukasDoubleU/Kladde/commit/8fd2f881229826b815692ebe67d107751ef8f085))
- **keys:** Cover presets, chords, the shortcut editor and unbinding end to end ([35fc4e0](https://github.com/LukasDoubleU/Kladde/commit/35fc4e0cba936d004c506df9cdc07e47fbab13e5))
- Wait for the command palette before typing into it ([5e8610d](https://github.com/LukasDoubleU/Kladde/commit/5e8610d030a95f184a22db95ff8ac9bf90549e8f))
- **grammar:** Cover grammar checking end to end with a fake server ([be844ff](https://github.com/LukasDoubleU/Kladde/commit/be844ff78f8441a920f95729b4c8fdf2168f33e6))

### 🏗️ Build and CI

- **e2e:** Run end-to-end tests one at a time with a longer start timeout ([d6da332](https://github.com/LukasDoubleU/Kladde/commit/d6da332d520a4e0c238a7caeaeeece3a791f312f))
- **release:** Sign the installer and publish update data ([30ed0b6](https://github.com/LukasDoubleU/Kladde/commit/30ed0b613208d1a0f8d9c29f1e55e5969824b997))
- **e2e:** Run the smoke test first and collect diagnostics on failure ([3661e86](https://github.com/LukasDoubleU/Kladde/commit/3661e8625710f062d0d25081e357db2801dbedb4))
- **e2e:** Make the end-to-end job non-blocking until it runs on the runner ([e9a168a](https://github.com/LukasDoubleU/Kladde/commit/e9a168a40b29bb29a2027de590a7a64659cc8fe2))
- **release:** Push the release commit and the tag atomically ([536fbf1](https://github.com/LukasDoubleU/Kladde/commit/536fbf190db282516877f59ab30a1bec8bc17b99))
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
