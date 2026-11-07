# RemoteDeck Android

Android WebView 外壳，把 RemoteDeck 的网页控制台变成独立 App。

## 功能

- 首次启动扫描电脑上 RemoteDeck 的二维码，自动保存设备地址。
- 之后启动直接进入最近设备；WebView Cookie 持久化，登录一次即可继续使用。
- 支持保存多台电脑，工具栏「设备」可切换。
- 「多开」通过 Android 多任务/分屏打开同一设备的独立窗口；不同设备可分别开窗。
- HTTP 地址可用（`usesCleartextTraffic`），适配 Tailscale 直连。
- 原生 `FLAG_KEEP_SCREEN_ON` 与网页「防止熄屏」开关联动。
- 内置 WebView 返回、刷新、错误重试和「打开 Tailscale」。

## Tailscale 自动连接说明

App 会在地址属于 Tailscale（`100.64.0.0/10` 或 `*.ts.net`）时：

1. 检测 VPN 是否已经建立；
2. 向 Tailscale Android 发送非官方 `CONNECT_VPN` / `TOGGLE_VPN` 广播；
3. 失败时显示「打开 Tailscale」按钮，由用户手动连接。

Android 不允许普通 App 强制开启另一个 App 的 VPN；如果系统或 Tailscale 版本忽略广播，需要：

- 首次在 Tailscale 中允许 VPN；
- 在 Android 设置里把 Tailscale 设为「始终开启的 VPN」；
- 或每次从 App 内点「打开 Tailscale」。

这是 Android 平台限制，不是 RemoteDeck 能绕过的。

## 构建设置

需要 JDK 17、Android SDK Platform 35、Build Tools 35.0.0。

```powershell
$env:ANDROID_HOME = 'C:\Users\<you>\Android\Sdk'
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.15.6-hotspot'
cd android
.\gradlew assembleDebug
```

产物：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

项目路径包含中文时，`gradle.properties` 已启用 `android.overridePathCheck=true`；如果仍然失败，把 `android/` 复制到纯 ASCII 路径再构建。

## 安装

1. 把 APK 传到手机；
2. 允许「安装未知应用」；
3. 安装后打开 RemoteDeck；
4. 扫描电脑 RemoteDeck「远程访问」页上的二维码；
5. 在 WebView 里输入一次访问密码。

APK 使用 debug 签名，适合个人侧载，不适合上架应用商店。

## 多设备 / 多开

- 在首页「扫描二维码」或「手动输入地址」添加多台电脑。
- 每台设备保存为独立 profile；不同主机的 Cookie 互不影响。
- 打开设备后点顶部「多开」可创建独立任务；在 Android 分屏/自由窗口里可并排查看。
- 同一主机的多个 profile 共享该主机的 WebView Cookie，这是 Android WebView 的限制。

## 安全

- 地址和 profile 只保存在本机 SharedPreferences。
- 登录态由 WebView Cookie 保存；没有额外保存密码。
- 支持 HTTP 是为了 Tailscale 私有 IP 直连；公网使用请优先 Tailscale Serve 或 Cloudflare HTTPS。
- 不在 WebView 中忽略 SSL 错误。
