import type { NextConfig } from 'next';

const config: NextConfig = {
  // A static site: no server at request time (spec section 8). It can be hosted on any static host.
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  transpilePackages: ['@vitamine/sun', '@vitamine/shadow'],
};

export default config;
