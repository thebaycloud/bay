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
      {
        // The deploy film, loaded by the ROOM — the waiting page the proxy
        // serves at every app's own address (services/proxy/src/room-page.ts).
        // That is a different origin, and it is a <script src>, which needs no
        // permission to run; the CORS header is here anyway so the same file can
        // be fetched or imported as a module later without a second deploy to
        // find out it could not be.
        //
        // NOT immutable, unlike the fonts and the plates: this URL is stable and
        // its contents change with the picture, so an immutable year would pin
        // every waiting room to whatever the film looked like on the day the
        // browser first saw it. Ten minutes is long enough that a room reopened
        // during one build does not refetch 600 KB, and short enough that a
        // change to the film is live everywhere within a coffee.
        source: "/film/:file*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=600" },
        ],
      },
    ];
  },
};

export default nextConfig;
