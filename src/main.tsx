import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 不使用 React.StrictMode：开发环境下 StrictMode 会把 effect 按「挂载→清理→再挂载」
// 执行两遍。本应用对话框的 effect 会真实下发 AT 指令并触发模块软重启，双执行会造成：
// 1) 指令被重复发送（更早的「对话框闪一下就消失」等异常多源于此）；
// 2) 与「切换只执行一次」守卫（switchStartedRef）叠加时，第一遍启动的真实操作会被其
//    清理标记 cancelled 抑制全部 UI 回调，表现为「模块已切换成功，但对话框卡在
//    正在发送 AT 指令」。
// 对真机硬件副作用而言，StrictMode 的开发期双执行探测弊大于利，故移除。
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
