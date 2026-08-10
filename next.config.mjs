/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lets a verification build run into a scratch dir (NEXT_DIST_DIR=.next-check)
  // instead of clobbering the .next that a running dev server owns.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  experimental: {
    instrumentationHook: true,
  },
};

export default nextConfig;
