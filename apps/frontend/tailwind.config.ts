import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          0: '#030A14',
          1: '#071224',
          2: '#0B1A31',
        },
        accent: {
          DEFAULT: '#1EC8FF',
          2: '#00E5B4',
        },
        warn: '#FFB020',
        danger: '#FF5D6C',
        text: {
          1: '#E8F3FF',
          2: '#9CB3C9',
          3: '#6F859B',
        },
      },
      boxShadow: {
        glow: '0 0 20px rgba(30,200,255,0.25)',
      },
    },
  },
  plugins: [],
}
export default config
