# CellularSwitch

在浏览器里利用 WebUSB 一键修改 4G 模块的 USB 设备标识（VID/PID）。

纯网页实现，在 macOS / Linux 上免驱。

> 在 Windows 上需要：
>
> - 下载并打开 [Zadig](https://zadig.akeo.ie/)，在 Options 菜单下勾选 List All Devices
> - 选择模块 AT 口（Interface 3），将驱动替换为 WinUSB
> - 修改模块标识后需要再操作一次

## 功能

- 自动识别模块当前状态（原始 / 已修改）
- 一键修改 / 恢复模块的 USB 设备标识
- 查看运行状态：网络模式、频段、信道、注册状态、信号强度
- 查看设备信息：IMEI、ICCID、IMSI、本机号码
- 切换工作模式：QMI / ECM
- 全程在浏览器内完成，支持 Chrome / Edge 桌面版

## 使用方法

1. 用支持 WebUSB 的桌面浏览器（Chrome / Edge）打开页面
2. 将 4G 模块插入电脑，点击「连接」
3. 根据页面提示完成修改或恢复

## 本地开发

```bash
npm install
npm run dev       # 开发预览 → http://localhost:5173/
npm run build     # 生产构建 → dist/
npm run preview   # 预览构建产物
```

## 技术栈

React · TypeScript · Tailwind CSS · Vite

## 免责声明

本工具用于在**自己的设备**上调整 USB 设备标识。修改设备标识可能导致保修失效、设备异常或无法被部分软件识别，请确认了解相关风险后再操作。作者不对任何设备损坏、数据丢失或其他后果承担责任。
