import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // 相对 base：开发服务器在网站根目录打开（http://localhost:5173/），
  // 构建产物使用相对路径，部署到 GitHub Pages 子路径时同样有效。
  base: './',
  plugins: [react()],
})
