# Put this project on your PC Desktop

This zip was built for local play. After download:

## macOS / Linux

```bash
cd ~/Desktop
unzip fog-of-war-tank-hunt.zip -d fog-of-war-tank-hunt
cd fog-of-war-tank-hunt
npm install
npm run dev
```

Open http://127.0.0.1:4731

## Windows (PowerShell)

```powershell
cd $env:USERPROFILE\Desktop
Expand-Archive .\fog-of-war-tank-hunt.zip -DestinationPath fog-of-war-tank-hunt
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
