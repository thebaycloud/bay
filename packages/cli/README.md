# supersonic-cli

Deploy anything to [Supersonic](https://app.supersonic.cv) in one command.

```bash
npm install -g supersonic-cli
```

## Usage

```bash
supersonic login                 # authenticate (defaults to app.supersonic.cv)
supersonic deploy                # deploy the current repo (uses your git origin)
supersonic deploy --repo <url>   # or deploy any public git repo
supersonic whoami
supersonic logout
```

`supersonic deploy` streams the live build log — clone → detect stack → build → Cloud Run — and prints your live URL when it's up.

## Options

- `supersonic login --url <control-plane>` — point at a different control-plane (defaults to `https://app.supersonic.cv`; also settable via `SUPERSONIC_URL`).
- `supersonic login --email <e>` — skip the email prompt. Password can be piped via `SUPERSONIC_PASSWORD`.

Your session is stored in `~/.supersonic/config.json`.
