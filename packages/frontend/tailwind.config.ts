import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      fontFamily: {
        sans: ['Space Grotesk', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['Space Mono', 'JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Extended semantic colors
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
        },
        // Surface hierarchy
        mantle: 'hsl(var(--surface-mantle))',
        crust: 'hsl(var(--surface-crust))',
        'surface-0': 'hsl(var(--surface-0))',
        'surface-1': 'hsl(var(--surface-1))',
        'surface-2': 'hsl(var(--surface-2))',
        // Catppuccin accent palette (direct access)
        ctp: {
          lavender: 'hsl(var(--ctp-lavender))',
          blue: 'hsl(var(--ctp-blue))',
          sapphire: 'hsl(var(--ctp-sapphire))',
          sky: 'hsl(var(--ctp-sky))',
          teal: 'hsl(var(--ctp-teal))',
          green: 'hsl(var(--ctp-green))',
          yellow: 'hsl(var(--ctp-yellow))',
          peach: 'hsl(var(--ctp-peach))',
          maroon: 'hsl(var(--ctp-maroon))',
          red: 'hsl(var(--ctp-red))',
          mauve: 'hsl(var(--ctp-mauve))',
          pink: 'hsl(var(--ctp-pink))',
          flamingo: 'hsl(var(--ctp-flamingo))',
          rosewater: 'hsl(var(--ctp-rosewater))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'pulse-gentle': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'pulse-gentle': 'pulse-gentle 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}

export default config
