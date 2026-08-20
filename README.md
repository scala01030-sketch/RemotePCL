# RemotePCL

RemotePCL 是一个仅绑定到用户明确选择的 Minecraft Java 窗口的低延迟串流原型。当前实现包含桌面 Host、H.264 网络视频、Web 调试客户端和 Minecraft 目标内输入适配器；音频仍未实现。

## 当前数据流

```text
Capture
→ Encoder
→ EncodedFrame
→ LocalDecoder
→ Preview
```

网络消费者使用同一个编码边界：

```text
Capture
→ Encoder
→ EncodedFrame
→ NetworkTransport
```

Capture 和 Encoder 不依赖本地预览、Socket 或客户端生命周期。

## 编码输出契约

`src/media/encoded-frame.js` 定义冻结的 `EncodedFrame`：

```text
frameId: bigint
codec: H264
pts: bigint
dts: bigint | null
captureTimestamp: process.hrtime.bigint 单调时钟
encodeCompleteTimestamp: 同一单调时钟
width / height: uint32
keyFrame: boolean
data: 真实 H.264 编码访问单元 Buffer
```

当前输出格式是 **H.264 Annex B**。SPS/PPS 通过独立 `CodecConfig` 明确发布；消费者不需要猜测配置。`EncodedFrameHub` 支持 LocalDecoder、网络传输和调试记录器等多个独立消费者。

## 视频传输

正常链路：

```text
Minecraft B → gfxcapture → NVENC H.264 Annex B
→ WebSocket → WebCodecs VideoDecoder → Canvas
```

- 默认 60 FPS、8 Mbps CBR。
- 编码和 H.264 配置跟随会话启动时的 Minecraft B 捕获分辨率。
- B 帧及 lookahead 关闭，关键帧间隔约 0.25 秒。
- 服务端 H.264 发送积压超过 96 KiB 时断开旧队列；客户端解码队列超过 2 帧时重新连接并等待新关键帧。
- JPEG 只作为显式兼容模式。降级会显示 Toast，并记录 H.264/JPEG 帧数及原因。
- JPEG 兼容流保持源捕获宽度，不再固定缩小为 768 像素。
- 本地桌面预览仍消费 `EncodedFrame`，经 NVDEC 解码后生成预览画面；Encoder 不直接调用 Renderer。

H.264 二进制包使用版本化的 `RPCL` v2 帧头，包含捕获、编码完成、发送及最近输入关联时间戳。它是当前调试协议，不是未来 UDP packet header、MTU/FEC/重传设计。

## 输入隔离

远程输入不使用 `SendInput`、`SetCursorPos`、`PostMessage` 或前台窗口检测。Host 将一个小型 Java Agent 只附加到选定 PID 的 Minecraft JVM，并在该实例的游戏主线程更新：

- `KeyMapping`：W/A/S/D、跳跃、疾跑、潜行、攻击、使用等；
- 玩家视角：相对 LOOK；
- 原生快捷栏：直接选择 1–9；
- `Screen`：暂停、背包和其他 GUI 的点按；
- 聊天界面文字输入。

适配器通过一次性本地令牌与 Host 连接，回报目标 PID 和 Minecraft GUI 状态。目标 JVM、窗口身份或适配器失效后，会话停止；不会切换到 Minecraft A，也不会回退到 Windows 全局输入。

当前目标 JVM 必须包含 `jdk.attach`，并允许动态加载 Agent。若不满足要求，启动会明确失败。

## 手机 Web 调试客户端

Web Client 用于协议、视频和触控调试，不是最终 Android APK。

- 左下角是圆形全方向摇杆，并支持 W/A/S/D 组合方向。
- 跳跃、疾跑和潜行为少量高频动作按钮。
- 画面拖动控制视角；轻点攻击；长按持续挖掘；双指轻点使用/放置。
- 不显示第二套 1–9 按钮。原生快捷栏点击区域根据 Minecraft 当前 GUI 缩放动态计算。
- Host 回传 `screenOpen`，暂停/背包打开时自动切换为 GUI 点按模式。
- 灵敏度可在 25%–300% 调整并保存在浏览器本地。
- 关键异常使用 Toast；详细传输和输入事件记录在日志页及 Host `.log` 文件中。

浏览器的全屏、长按、地址栏和 WebCodecs 支持存在平台差异。正式客户端目标仍是 Android Native APK。

## 分段延迟诊断

当前 v2 协议记录或估算：

1. 手机触控事件时间；
2. 手机发送开始时间；
3. Host 收到输入时间；
4. Host 输入执行完成时间；
5. 执行后首个关联捕获帧时间；
6. 编码完成时间；
7. Host 提交视频发送时间；
8. 客户端收到时间；
9. WebCodecs 解码完成时间；
10. Canvas 提交显示时间。

日志分别输出 touch-to-send、输入上行、Host 输入、输入到捕获、编码、发送排队、下行、解码、显示以及操作到显示的端到端时间。跨设备单调时钟通过 ping 中点估算偏移，因此网络分段是诊断估算值，不是硬件时钟同步测量。

## 使用

```powershell
cd E:\RemotePCL
npm install
npm test
npm run ui
```

桌面端步骤：刷新实例、根据 PID/HWND 选择 Minecraft B、选择帧率和码率、开始串流。Host 会直接弹出手机地址和六位配对码。

也可从命令行启动：

```powershell
node scripts\remote-session-server.js --hwnd 0x000A04AC --fps 60 --bitrate 12M
```

目标分辨率改变时，会话按明确策略停止并提示重新启动，以新的捕获分辨率重新初始化编码器；不会用旧尺寸继续缩放。

## 构建

```powershell
npm test
npm run build
```

构建脚本先按源码哈希选择输入 Agent：已有同哈希预构建 JAR 时直接复用，否则才要求 JDK 17+ 编译。随后生成：

```text
dist\RemotePCL-Phase1-0.1.0-portable.exe
```

便携 EXE 内含应用、输入 Agent 和项目固定的 FFmpeg runtime。`vendor\remote-input-agent\current-agent.txt` 明确记录当前 Agent；安装包只携带规范名为 `remote-input-agent.jar` 的这一份，不按解压时间或历史 JAR 的修改时间猜测版本。

## 日志与诊断

桌面日志：

```text
%APPDATA%\RemotePCL\logs\RemotePCL-<time>.log
```

命令行远程会话日志：

```text
E:\RemotePCL\logs\RemotePCL-Remote-<time>.log
```

常用检查：

```powershell
npm test
node scripts\h264-transport-smoke.js http://127.0.0.1:4173 <PIN>
node scripts\gui-interaction-smoke.js http://127.0.0.1:4173 <PIN>
node scripts\pair-state-smoke.js http://127.0.0.1:4173 <PIN>
node scripts\remote-input-smoke.js http://127.0.0.1:4173 <PIN> LOOK
node scripts\input-isolation-smoke.js http://127.0.0.1:4173 <PIN> <Minecraft-A-HWND>
node scripts\electron-ui-smoke.js 9222 <Minecraft-B-HWND>
```

自动化结果不能替代真实手机验收。最终必须使用状态：`NOT IMPLEMENTED`、`IMPLEMENTED / NOT VERIFIED`、`VERIFIED PASS`。

## 当前限制

- 音频为 `NOT IMPLEMENTED`。`/media/audio` 明确返回不可用，不会用麦克风或全系统声音冒充 Minecraft B 音频。
- Web Client 是调试客户端；Android Native APK 尚未实现。
- 关闭 B 后继续操作手机的真实人工验收仍需在允许终止测试实例时执行。
- 目标分辨率变化需要重启会话。
- 互联网暴露、UDP、MTU 分片、重传、FEC 和 NAT 穿透不在当前阶段范围内。

## 2026-08-20 本机回归证据

在同时运行的 Minecraft A/B 上：

- 目标 B LOOK 画面平均差异：37.37；
- 非目标 A 同期画面平均差异：0.19；
- Windows 光标操作前后坐标完全相同；
- ESC 暂停/返回、暂停菜单直接点按、背包打开、快捷栏 4、跳跃、潜行、疾跑均在真实 B 窗口产生响应；
- 即使桌面控制台持有 Windows 焦点，远程 ESC 也能关闭失焦暂停页；新配对会立即收到当前 `PauseScreen` 状态；
- H.264 Annex B v2 transport smoke 收到真实 IDR；
- 便携 EXE 的真实 Renderer 操作完成刷新、选定 B、启动，并显示 854×480 本地解码预览；
- 本地捕获约 58–60 FPS，编码/解码约 60/60 FPS，稳定阶段处理管线约 4.4–5.4 ms；
- 同一真实手机曾以 `h264-webcodecs` 显示约 57–63 FPS，日志为 `jpeg=0`、`fallback=none`。

电脑端协议到真实 Minecraft B、本地预览及手机 H.264 显示已分别验证。手机触控到 B 再到手机最终显示的完整单次操作闭环仍标为 `IMPLEMENTED / NOT VERIFIED`；不能用分段测试替代这项人工验收。
