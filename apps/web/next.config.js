/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@knowledge/types', '@knowledge/config'],
};

module.exports = nextConfig;
