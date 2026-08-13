// 仅保留无法用现成图标库替代的自定义 SVG：
// - 场景插画（笔记本 + 4G 模块 / 浏览器不支持示意）
// - 进度环（animate-spin 的圆弧）
// - 品牌系统图标（Apple / Windows / Linux，lucide 不收录商标 logo）
// 其余描边小图标与状态徽章已收敛到 lucide-react。
export { ModuleComputerIllustration } from './ModuleComputerIllustration'
export { UnsupportedIllustration } from './UnsupportedIllustration'
export { ProgressRing } from './ProgressRing'
export { AppleIcon, WindowsIcon, LinuxIcon } from './OsIcons'
