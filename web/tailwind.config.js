/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        cohort: {
          ink: "#1a1a2e",
          rose: "#e8a598",
          cream: "#faf6f2",
        },
      },
    },
  },
  plugins: [],
};
