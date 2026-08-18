import { mountFilm } from "./ship-it";
import { drive, railIndex, START } from "@/lib/deploy-film";

/**
 * The film, as one script tag, for a page that is not this app.
 *
 * The dashboard imports the film as a module and lets the bundler deal with it.
 * The ROOM cannot: it is served by the proxy (services/proxy/src/room-page.ts)
 * at the app's own address, it is one hand-written HTML string with no build
 * step, and its Docker context does not contain this directory. So the film is
 * also emitted as a plain script — `npm run film`, into public/ — and the room
 * loads it from app.supersonic.cv.
 *
 * The DRIVER ships with it, deliberately. Without that, the room would need its
 * own copy of the stage-to-shot table, and a table that exists twice is a table
 * that will disagree with itself the first time a stage is added. One artefact,
 * one mapping, two pages.
 */
declare global {
  interface Window {
    SupersonicFilm?: {
      mountFilm: typeof mountFilm;
      drive: typeof drive;
      railIndex: typeof railIndex;
      START: typeof START;
    };
  }
}

window.SupersonicFilm = { mountFilm, drive, railIndex, START };
