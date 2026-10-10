# Put this project on your PC Desktop (no WSL)

You do **not** need WSL or the Origin CLI to play locally. Use the zip.

## Windows (PowerShell)

1. Download `fog-of-war-tank-hunt.zip` (from this agent’s Try Live URL path `/fog-of-war-tank-hunt.zip`, or the artifact attached in the agent).
2. Then:

```powershell
cd $env:USERPROFILE\Desktop
Expand-Archive .\fog-of-war-tank-hunt.zip -DestinationPath fog-of-war-tank-hunt
cd fog-of-war-tank-hunt
npm install
npm run dev
```

Open http://127.0.0.1:4731

## macOS / Linux

```bash
cd ~/Desktop
unzip fog-of-war-tank-hunt.zip -d fog-of-war-tank-hunt
cd fog-of-war-tank-hunt
npm install
npm run dev
```

## API key

Edit `src/api-key.local.ts` and set:

```ts
export const LOCAL_API_KEY = "AIza..."; // Gemini, or sk-... for OpenAI
```

Then restart `npm run dev` if it was already running.

## Optional: Origin git (needs WSL on Windows)

The Origin CLI is macOS/Linux/WSL only. Skip it unless you specifically want `git clone` of https://cursor.com/codebase/janaaa-dev/Tanki.
