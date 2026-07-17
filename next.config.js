/** @type {import('next').NextConfig} */
const protectedResponseHeaders = [
  { key: "Cache-Control", value: "no-store" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      { source: "/", headers: protectedResponseHeaders },
      { source: "/api/:path*", headers: protectedResponseHeaders },
    ];
  },
};

module.exports = nextConfig;
