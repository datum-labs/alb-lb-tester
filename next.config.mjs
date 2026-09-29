/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Datum Compute image (Dockerfile.datum) runs Next's self-contained
  // server; Vercel builds leave this unset and deploy as usual.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' } : {}),
};
export default nextConfig;
