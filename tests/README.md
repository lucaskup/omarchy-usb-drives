# Tests

Only Node.js (22.8 or newer) is needed. The plugin itself does not use Node.

| Command | What it runs |
|---|---|
| `npm test` | Everything below except the integration tests |
| `npm run test:coverage` | Same, and fails if `Model.js` drops below 100% line, branch or function coverage |
| `npm run test:integration` | Real udisks tests on throwaway loop devices (see below) |

## What is covered

- **`model.test.mjs`**: every function in `Model.js`. It uses a real `lsblk`
  capture (`fixtures/real-vfat-stick.txt`) plus built-up cases: multiple
  partitions, installer ISOs, LUKS (locked, unlocked, unlocked but not
  mounted), SD cards, empty card slots, and broken output.
- **`scripts.test.mjs`**: every script in `scripts/`, run with real bash
  against fake `lsblk`, `udisksctl`, `udiskie-mount`, `fuser`, `ps`, `setsid`,
  `xdg-open` and `notify-send` (`helpers/fake.mjs`). `PATH` contains only
  those fakes plus a fixed set of coreutils, so "tool not installed" is
  tested by leaving a fake out. The fake sysfs covers link speed and stats.
- **`contract.test.mjs`**: checks that the parts agree with each other.
  - Manifest entry points exist and the plugin id is used consistently.
  - The settings schema, its defaults and `setting()` calls match.
  - QML only calls functions that `Model.js` defines.
  - Every script exists, is executable and is actually used.
  - It guards against shell pitfalls we hit before: bare `vertical` in a
    `Panel`, and `bar.shellQuote`.
  - It runs `bash -n`, `shellcheck` and `qmllint` (syntax errors only). A
    tool that is not installed is skipped.

## Integration tests

```sh
npm run test:integration
```

Needs a logged-in desktop session (udisks only lets the active seat mount
without a password), `cryptsetup` and `gdbus`. The tests make small disk
images and attach them as loop devices through udisks. Then they run
`eject.sh` and `open.sh` for real: LUKS unlock and lock, busy detection with
a real `fuser`, and mounting. Loop devices cannot be powered off, so eject is
expected to fail only at that last step. Everything is detached and deleted
afterwards. A running udiskie may automount the test images, and the tests
allow for that.

udiskie also opens a passphrase dialog for every new encrypted device,
including the test image. So while udiskie is running, the LUKS test is
skipped. To run it anyway, set `USB_DRIVES_INTEGRATION_LUKS=1` and cancel the
dialog when it appears.
