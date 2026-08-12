/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: '#007aff',
        page: '#f4f4f4',
      },
    },
  },
  plugins: [],
}
