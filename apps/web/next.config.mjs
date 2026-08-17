/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  async headers() {
    return [
      {
        // The panel is injected into a hosted app and runs on that app's own
        // hostname, so every asset it asks us for is a cross-origin request.
        // Images do not need permission to be drawn, but FONTS DO: a font is
        // fetched in CORS mode always, and without this header the browser
        // fetches it, refuses to hand it over, and silently falls back — which
        // looks exactly like the font not existing.
        //
        // Safe to open to everyone, unlike the JSON routes next door: these are
        // two static typefaces with no session behind them and nothing to leak.
        // See lib/cors.ts for why the API routes are the opposite of this.
        source: "/fonts/:file*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        // Same reasoning minus the CORS: the button plates are background
        // images, which need no permission, but do want the long cache.
        source: "/metal/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
