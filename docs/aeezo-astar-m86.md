# AEEZO / astar-m86 (Allwinner sun8i, Android 6.0.1): setup log

One unit, set up 2026-10-10 from a Mac (macOS 27) over USB through a hub. It is the same board
family as [allwinner-a33-pf1007l.md](allwinner-a33-pf1007l.md), but a **newer firmware build that
ships with root ADB enabled**, so none of the FEL / boot-patch work was needed.

## Identity (observed)

| Item | Value |
| --- | --- |
| USB | `1f3a:1002`, manufacturer "USB Developer", product "Android"; `sys.usb.config=mass_storage,adb` out of the box |
| `adb devices -l` | `product:astar_m86_8723cs model:AEEZO device:astar-m86_8723cs` |
| Fingerprint | `AEEZO/astar_m86_8723cs/astar-m86_8723cs:6.0.1/MOB30R/20260410:eng/test-keys` (PF1007L doc: `20260113`) |
| `ro.hardware` / platform | `sun8i` / `astar`, 4× ARMv7, `armeabi-v7a`, SDK 23 |
| `adb shell id` | `uid=0(root)` without `su`; SELinux `Disabled` |
| `/system/xbin/su` | present; `su -c id` fails (`invalid uid/gid '-c'`), not needed |
| RAM / swap | 1 GiB; 256 MiB zRAM already configured |
| Stock WebView | `com.android.webview` 44.0.2403.119 in `/system/app/webview` (apk + `oat/arm/webview.odex`) |
| Vendor apps | `com.efercro.os.aimor` 6.0.78 (`/system/priv-app/launcher_aimor`), `com.yhk.qeota` `API_10-usaFrame-P-L_Yes-20240603` (`/system/priv-app/frame_ota`) |
| Trust store | 158 roots; includes GlobalSign Root CA (`b0f3e76e.0`), no ISRG or GTS roots |

Partition layout (512-byte sectors), from `/sys/class/block/mmcblk0p*/start,size`:

| Name | Device | Start | Size |
| --- | --- | ---: | ---: |
| bootloader | mmcblk0p2 | 73728 | 65536 |
| env | mmcblk0p5 | 139264 | 32768 |
| boot | mmcblk0p6 | 172032 | 65536 |
| system | mmcblk0p7 | 237568 | 2097152 (1 GiB, mounted ro) |
| misc | mmcblk0p8 | 2334720 | 65536 |
| recovery | mmcblk0p9 | 2400256 | 65536 |
| cache | mmcblk0p10 | 2465792 | 1572864 |
| metadata | mmcblk0p11 | 4038656 | 32768 |
| private | mmcblk0p12 | 4071424 | 65536 |
| frp | mmcblk0p13 | 4136960 | 1024 |
| empty | mmcblk0p14 | 4137984 | 31744 |
| alog | mmcblk0p15 | 4169728 | 163840 |
| media_data | mmcblk0p16 | 4333568 | 32768 |
| UDISK (`/data`) | mmcblk0p1 | 4366336 | 26411008 |

## Host problem: Homebrew adb crashes

`adb` 37.0.1 (Homebrew `android-platform-tools`) aborts within seconds on macOS 27
(`Abort trap: 6`, log line `libunwind: stepWithCompactEncoding - invalid compact unwind encoding`).
The crash report's faulting thread is `libadbmdns_zero_config_driver`: a Rust panic while parsing
an mDNS service name seen on the LAN. Running with **`ADB_MDNS=0`** fixes it. The crashes left the
frame's adbd endpoint wedged (`usb_write failed e00002eb`); replugging the cable cleared it.
Platform-tools r35.0.2 did not crash but never listed the device on this macOS.

## Backup (read-only, over root ADB)

Stored privately in `backups/<serial>/` with `MANIFEST.json` (sizes, SHA-256):

- eMMC sectors 0–4,366,335 (everything before `UDISK`), 2,235,564,032 bytes, ~297 MB gzipped,
  249 s over USB 2.0. No all-`0xCC` blocks. gzip readback matched the SHA-256.
- Independent re-read of the raw area before `bootloader` and of every partition up to
  `media_data`: all byte-identical to the image (including `cache`, which was idle).
- `mmcblk0boot0` / `mmcblk0boot1` (4 MiB each; boot1 all zero), each read twice and compared.
- `toybox tar` of the stock `/system/app/webview` tree, read twice and compared.

Not included: `UDISK` (user data). Restoring partitions needs a board-specific writer; nothing
below wrote raw partitions.

## Changes made

1. Installed Rootless Pixel Launcher 3.9.1 and Firefox 143.0.4 (SHA-256 pinned, as in the
   PF1007L guide).
2. `pm disable com.efercro.os.aimor` and `com.yhk.qeota`; waited for `enabled="2"` to appear in
   `package-restrictions.xml` (about 10 s) before rebooting. Both stayed disabled after reboot.
3. WebView 44 → 106.0.5249.126 following PF1007L section 6: staged in `/data/local/tmp`, built
   `/system/homehq-new-webview` (apk + `lib/arm/*.so`, root:root, 0755/0644), read every file
   back, moved the stock tree to `/system/homehq-stock-webview`, moved the new tree to
   `/system/app/webview`, read back again, remounted `/system` ro, rebooted. After boot:
   `versionName=106.0.5249.126`, RelroFileCreator loaded `/system/app/webview/lib/arm/libwebviewchromium.so`,
   no `dlopen failed`.
4. Installed the kiosk (`dashboard/kiosk`) and selected it as the default Home app (Always).

## TLS on this trust store

Wes's `wesbos.workers.dev` loaded on the stock store: its chain is leaf → WE1 → GTS Root R4,
cross-signed by GlobalSign Root CA, which the frame trusts. A newly created workers.dev subdomain
got a Let's Encrypt certificate instead (leaf → YE2 → Root YE → ISRG Root X2). The frame has no
ISRG roots, so the kiosk failed with `net_error -202` and kept showing the previous page. During
the first minutes after deploy it also failed with `-11 ERR_SSL_VERSION_OR_CIPHER_MISMATCH`
while Cloudflare was still issuing the certificate; the kiosk's 10 s retry covers that case.

Cloudflare Universal SSL can renew from Let's Encrypt, Google Trust Services or SSL.com, so the
current roots of all three were added to `/system/etc/security/cacerts/` (root:root 0644). Each
was checked by SHA-256 against both Mozilla's bundle (curl.se) and the macOS system roots, and
read back after writing:

| Root | File |
| --- | --- |
| ISRG Root X1 | `6187b673.0` |
| ISRG Root X2 | `8794b4e3.0` |
| GTS Root R1 | `f013ecaf.0` |
| GTS Root R3 | `6b03dec0.0` |
| GTS Root R4 | `5acf816d.0` |
| SSL.com TLS RSA Root CA 2022 | `2c63f966.0` |
| SSL.com TLS ECC Root CA 2022 | `cbb3f32b.0` |

GTS Root R2 was left out: the copy from pki.goog did not match Mozilla's bundle. Restarting the
kiosk process was enough for WebView to pick up the new roots. Other third-party HTTPS hosts
can still fail, so the dashboard serves every resource, including iCloud photos, from the Worker.

## Undo

- Kiosk as Home: Settings → Apps → Home HQ → Clear defaults (or uninstall `com.wesbos.homehq`).
- Vendor apps: `adb shell pm enable com.efercro.os.aimor; adb shell pm enable com.yhk.qeota`.
- WebView: `mount -o remount,rw /system; mv /system/app/webview /system/homehq-new-webview;
  mv /system/homehq-stock-webview /system/app/webview`, check it against the backup tar,
  `mount -o remount,ro /system`, reboot.
- Apps: `adb uninstall org.mozilla.firefox amirz.rootless.nexuslauncher` once another Home works.
- CA roots: `mount -o remount,rw /system`, delete the seven files listed above, remount ro.
