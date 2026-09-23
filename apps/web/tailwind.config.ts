import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#F5F2FC",
        ink: "#2A2521",
        accent: {
          sky: "#2F9BEF",
          sunflower: "#F5B82E",
          lavender: "#A48EF0",
          pink: "#EF6C93",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        body: ["var(--font-body)", "sans-serif"],
      },
      boxShadow: {
        tactile: "0 1px 2px rgba(42,37,33,0.06), 0 6px 16px -4px rgba(42,37,33,0.18)",
        "tactile-hover": "0 2px 4px rgba(42,37,33,0.08), 0 10px 22px -6px rgba(42,37,33,0.26)",
      },
    },
  },
  plugins: [],
};

export default config;
