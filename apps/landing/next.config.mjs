/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Where the build output goes.
   *
   * A verification build run while a dev server is up overwrites the `.next` that
   * server is reading, and the page comes back unstyled or dies on a missing
   * chunk, because dev and production emit different filenames. Setting
   * NEXT_DIST_DIR sends a one-off build somewhere else and leaves the dev
   * server's output alone. apps/web already does this with `.next-verify`.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",


  /**
   * The manual has one file and several names, because the names are guesses.
   * An agent told "read the docs at thebay.cloud" will try /llms.txt if it
   * knows that convention and /AGENTS.md or /cli.md if it doesn't, and a guess
   * that 404s costs a turn to recover from. `middleware.ts` covers the last
   * guess: the bare root under curl.
   */
  async rewrites() {
    return ["/agents.md", "/AGENTS.md", "/agents.txt", "/cli.md"].map((source) => ({
      source,
      destination: "/llms.txt",
    }));
  },
};

export default nextConfig;
