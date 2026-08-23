/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * The manual has one file and several names, because the names are guesses.
   * An agent told "read the docs at thebay.cloud" will try /llms.txt if it
   * knows that convention and /AGENTS.md or /cli.md if it doesn't, and a guess
   * that 404s costs a turn to recover from. `middleware.ts` covers the last
   * guess — the bare root under curl.
   */
  async rewrites() {
    return ["/agents.md", "/AGENTS.md", "/agents.txt", "/cli.md"].map((source) => ({
      source,
      destination: "/llms.txt",
    }));
  },
};

export default nextConfig;
