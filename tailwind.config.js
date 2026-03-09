/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        claude: {
          50: '#fdf4f0',
          100: '#fbe5db',
          200: '#f7c8b3',
          300: '#f2a482',
          400: '#ec7c4f',
          500: '#e66b2e',
          600: '#d45420',
          700: '#b0411a',
          800: '#8d361c',
          900: '#73301b',
        },
      },
    },
  },
  plugins: [],
};
